import { Router, Request, Response } from 'express';
import logger from '@utils/logger.js';
import { requireLocalAuth, requireAdmin } from '@middleware/auth-local.middleware.js';
import { DerivAPIService, DerivTokenExpiredError } from '@services/deriv-api.service.js';
import { config } from '@config/index.js';

const router: Router = Router();

// ─── Lista de admins ──────────────────────────────────────────
// Mesma fonte usada em server.ts (fluxo WebSocket: session.isAdmin).
// Configurada via variável de ambiente:
//   ADMIN_ACCOUNT_IDS=DOT90000001,DOT90000002
// Lida aqui directamente do process.env (não de config/index.ts)
// para evitar duplicar/desincronizar a definição entre os dois
// pontos do código que precisam dela.
const ADMIN_IDS = new Set<string>(
  (process.env.ADMIN_ACCOUNT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
);

/**
 * GET /api/admin/check
 *
 * Verifica se a conta identificada pelo header "x-cr" está na lista
 * de admins. Usado pelo frontend (api.checkAdmin) para decidir se
 * mostra o painel "DASHBOARD ADMIN" no menu.
 *
 * Não exige o accountId via query/body para manter consistência com
 * o que o frontend já envia (header x-cr), evitando duplicar a forma
 * de identificar a conta.
 */
router.get('/check', (req: Request, res: Response) => {
  const accountId = req.headers['x-cr'] as string | undefined;
  if (!accountId) {
    res.status(400).json({ isAdmin: false, error: 'Missing x-cr header' });
    return;
  }
  const isAdmin = ADMIN_IDS.has(accountId);
  logger.info('Admin check', { accountId, isAdmin });
  res.json({ isAdmin });
});

// ─── Relatório de Comissão (markup-statistics) ─────────────────

const MIN_YEAR = 2015;
const MAX_YEAR = 2100;

/**
 * Calcula o intervalo [primeiro dia, último dia] de um mês/ano,
 * em formato "YYYY-MM-DD". Se o mês pedido ainda estiver a decorrer
 * (mês/ano atual), o fim do intervalo é limitado a hoje — a Deriv
 * não tem dados de dias futuros.
 */
function monthRange(year: number, month: number): { from: string; to: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const from = new Date(Date.UTC(year, month - 1, 1));
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0));

  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const to = lastDayOfMonth > todayUTC ? todayUTC : lastDayOfMonth;

  return { from: fmt(from), to: fmt(to) };
}

/**
 * GET /api/admin/markup-statistics
 *
 * Aceita DOIS modos de filtro (mutuamente exclusivos):
 *   - ?month=7&year=2026        → relatório do mês inteiro
 *   - ?date_from=...&date_to=... → intervalo personalizado (YYYY-MM-DD)
 *
 * Relatório de comissão (markup) da APP LUCRO IA especificamente —
 * não da soma de todas as apps que possas ter registadas na Deriv.
 *
 * O token DERIV_MARKUP_TOKEN pertence ao afiliado/IB e pode reportar
 * várias apps de uma vez (uma linha por app_id no campo `breakdown`
 * da resposta da Deriv). Este endpoint filtra explicitamente pelo
 * app_id da Lucro IA (config.deriv.appId, mesma variável DERIV_APP_ID
 * já usada no resto do backend) e ignora as restantes apps do
 * afiliado — ver DerivAPIService.getAppMarkupStatistics().
 *
 * A comissão total é dividida 50/50 entre "Kelvin" e "Plataforma"
 * (commission_split na resposta) — percentagem fixa, ajustável aqui
 * se o acordo mudar.
 *
 * Protegida pelo sistema de sessão local (JWT + role 'admin'), já
 * que expõe dados financeiros da operação como um todo.
 */
router.get('/markup-statistics', requireLocalAuth, requireAdmin, async (req: Request, res: Response) => {
  const { month, year, date_from, date_to } = req.query as Record<string, string | undefined>;

  let dateFrom: string | undefined;
  let dateTo: string | undefined;

  if (month && year) {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR) {
      res.status(400).json({ error: 'Mês (1-12) ou ano inválidos' });
      return;
    }
    const range = monthRange(y, m);
    dateFrom = range.from;
    dateTo = range.to;
  } else {
    dateFrom = date_from;
    dateTo = date_to;
  }

  if (!dateFrom || !dateTo) {
    res.status(400).json({ error: 'Indica month+year, ou date_from+date_to (formato YYYY-MM-DD)' });
    return;
  }

  if (!config.deriv.markupToken) {
    logger.error('[Admin] DERIV_MARKUP_TOKEN não configurado');
    res.status(500).json({
      error: 'MARKUP_TOKEN_MISSING',
      message: 'Relatório de comissão não configurado no servidor (falta DERIV_MARKUP_TOKEN).',
    });
    return;
  }

  // app_id da Lucro IA — a mesma variável DERIV_APP_ID já usada
  // em todo o backend (headers Deriv-App-ID, OAuth, etc.). É por
  // este valor que filtramos o breakdown da Deriv, para nunca
  // misturar comissões de outras apps que possas ter no mesmo
  // token de afiliado.
  const lucroIaAppId = config.deriv.appId;
  if (!lucroIaAppId) {
    logger.error('[Admin] DERIV_APP_ID não configurado — impossível filtrar por app');
    res.status(500).json({
      error: 'APP_ID_MISSING',
      message: 'DERIV_APP_ID não está configurado no servidor — não é possível isolar a comissão da Lucro IA.',
    });
    return;
  }

  try {
    const deriv = new DerivAPIService(config.deriv.markupToken);
    const appResult = await deriv.getAppMarkupStatistics(dateFrom, dateTo, lucroIaAppId);
    const totalMarkup = appResult.total_app_markup_usd ?? 0;

    // Divisão fixa 50/50 — ajustar aqui se o acordo de parceria mudar.
    const KELVIN_PCT = 50;
    const PLATFORM_PCT = 50;
    const commissionSplit = {
      kelvin: Number((totalMarkup * (KELVIN_PCT / 100)).toFixed(2)),
      platform: Number((totalMarkup * (PLATFORM_PCT / 100)).toFixed(2)),
      kelvin_pct: KELVIN_PCT,
      platform_pct: PLATFORM_PCT,
    };

    logger.info('[Admin] Markup statistics consultadas (app Lucro IA)', {
      admin: req.localUser?.email,
      appId: lucroIaAppId,
      appFound: appResult.app_found,
      dateFrom,
      dateTo,
      totalMarkup,
    });

    res.json({
      app_id: appResult.app_id,
      app_found: appResult.app_found,
      total_app_markup_usd: appResult.total_app_markup_usd,
      total_volume_usd: appResult.total_volume_usd,
      total_payout_usd: appResult.total_payout_usd,
      total_contract_count: appResult.total_contract_count,
      total_client_count: appResult.total_client_count,
      date_from: dateFrom,
      date_to: dateTo,
      commission_split: commissionSplit,
    });
  } catch (error) {
    if (error instanceof DerivTokenExpiredError) {
      logger.warn('[Admin] Token de markup expirado/inválido', { admin: req.localUser?.email });
      res.status(424).json({
        error: 'DERIV_TOKEN_EXPIRED',
        message: 'O token da Deriv usado para o relatório de comissão expirou ou é inválido. Gera um novo em app.deriv.com/account/api-token (scope "Informações sobre o aplicativo") e atualiza DERIV_MARKUP_TOKEN no servidor.',
      });
      return;
    }
    logger.error('[Admin] Falha ao obter markup statistics', { error: (error as Error).message });
    res.status(502).json({ error: 'DERIV_REQUEST_FAILED', message: (error as Error).message });
  }
});

export default router;
