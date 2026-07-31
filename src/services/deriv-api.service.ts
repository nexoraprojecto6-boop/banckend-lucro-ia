// ============================================================
// LUCRO IA — Deriv API Service
// ============================================================
// Correcções aplicadas vs versão anterior:
//   ✅ Timeouts em todos os axios calls (evita travamentos)
//   ✅ createAuthenticatedWebSocket: removido ping duplicado
//      (o server.ts já gere o heartbeat — dois pings causavam
//       rate limit em sessões com muitos bots activos)
//   ✅ Mensagens de erro mais detalhadas nos logs
//   ✅ createPublicWebSocket: sem re-exportar — usar apenas
//      para dados públicos (active_symbols, etc.)
//   ✅ getMarkupStatistics — relatório de comissão (todas as
//      apps do token) (GET /applications/v1/markup-statistics)
//   ✅ NOVO: getAppMarkupStatistics — mesmo relatório, mas
//      filtrado por um app_id específico. O token
//      DERIV_MARKUP_TOKEN é do afiliado/IB e pode reportar
//      várias apps de uma vez (Lucro IA + outras apps tuas);
//      este método isola só a app pedida a partir do campo
//      `breakdown` da resposta, e recalcula os totais a partir
//      apenas dessa entrada — os totais "total_*" da resposta
//      da Deriv são agregados de TODAS as apps do token e não
//      devem ser usados directamente quando se quer só uma app.
//   ✅ NOVO: DerivTokenExpiredError — erro dedicado quando o
//      DERIV_MARKUP_TOKEN expira ou é inválido (o token de API
//      da Deriv tem validade máxima de 90 dias), para o admin
//      routes conseguir devolver uma mensagem clara ao frontend
//      em vez de um erro genérico 502.
// ============================================================

import axios from 'axios';
import WebSocket from 'ws';
import logger from '@utils/logger.js';
import { config } from '@config/index.js';

const DERIV_REST_BASE = 'https://api.derivws.com';
const REQUEST_TIMEOUT = 15_000; // 15s — axios default é infinito

// ─── Erros dedicados ────────────────────────────────────────

/**
 * Lançado quando a Deriv rejeita o token usado (expirado, revogado
 * ou com scope insuficiente) — status 401/403 ou códigos de erro
 * conhecidos da API. Distinto de outras falhas (rede, 5xx, etc.)
 * para que o caller possa dar uma instrução clara ao admin.
 */
export class DerivTokenExpiredError extends Error {
  constructor(message = 'Token da Deriv inválido, expirado ou sem permissão suficiente') {
    super(message);
    this.name = 'DerivTokenExpiredError';
  }
}

function isTokenError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status === 401 || status === 403) return true;
  const code =
    error.response?.data?.error?.code ??
    error.response?.data?.errors?.[0]?.code ??
    '';
  return ['InvalidToken', 'AuthorizationRequired', 'Unauthorized', 'PermissionDenied'].includes(code);
}

// ─── Tipos ───────────────────────────────────────────────────

export interface DerivAccount {
  account_id:   string;
  balance:      number;
  currency:     string;
  account_type: 'demo' | 'real';
  status:       string;
  group:        string;
  is_virtual?:  boolean;
  loginid?:     string;
  email?:       string;
  name?:        string;
}

interface OTPResponse {
  data: { url: string };
}

interface AccountsResponse {
  data: DerivAccount[];
}

export interface MarkupStatisticsBreakdown {
  app_id:          string;
  app_markup_usd:  number;
  volume_usd:      number;
  payout_usd:      number;
  contract_count:  number;
  client_count:    number;
}

export interface MarkupStatisticsData {
  total_app_markup_usd: number;
  total_volume_usd:     number;
  total_payout_usd:     number;
  total_contract_count: number;
  total_client_count:   number;
  breakdown:            MarkupStatisticsBreakdown[];
}

export interface MarkupStatisticsResponse {
  data: MarkupStatisticsData;
  meta: { endpoint: string; method: string; timing: number };
}

/**
 * Resultado de getAppMarkupStatistics — mesmo "shape" dos totais
 * de MarkupStatisticsData, mas calculado a partir de UMA única
 * entrada do breakdown (a app pedida). Inclui `app_found` para o
 * caller distinguir "esta app não teve movimento no período" de
 * "esta app nunca apareceu no breakdown" (ex: app_id errado).
 */
export interface AppMarkupStatistics {
  app_id:               string;
  app_found:            boolean;
  total_app_markup_usd: number;
  total_volume_usd:     number;
  total_payout_usd:     number;
  total_contract_count: number;
  total_client_count:   number;
}

// ─── DerivAPIService ──────────────────────────────────────────

export class DerivAPIService {
  private readonly token: string;

  constructor(token: string) {
    if (!token) throw new Error('DerivAPIService: token é obrigatório');
    this.token = token;
  }

  // ── Headers REST ─────────────────────────────────────────

  private get headers() {
    return {
      Authorization:  `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      // Deriv-App-ID apenas se configurado (novo endpoint pode não exigir)
      ...(config.deriv.appId ? { 'Deriv-App-ID': config.deriv.appId } : {}),
    };
  }

  // ── Contas ───────────────────────────────────────────────

  /**
   * GET /trading/v1/options/accounts
   * Lista todas as contas Options do utilizador.
   */
  async getAccounts(): Promise<AccountsResponse> {
    try {
      const response = await axios.get<AccountsResponse>(
        `${DERIV_REST_BASE}/trading/v1/options/accounts`,
        { headers: this.headers, timeout: REQUEST_TIMEOUT },
      );
      logger.info('[DerivAPI] Contas obtidas', { count: response.data.data?.length ?? 0 });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('[DerivAPI] Falha ao obter contas', {
          status: error.response?.status,
          data:   error.response?.data,
        });
        throw new Error(
          error.response?.data?.message ?? `Falha ao obter contas (HTTP ${error.response?.status})`,
        );
      }
      throw error;
    }
  }

  // ── OTP → URL WebSocket Privada ──────────────────────────

  /**
   * POST /trading/v1/options/accounts/{accountId}/otp
   * Gera OTP e retorna a URL WebSocket autenticada.
   *
   * IMPORTANTE: cada OTP é de uso único e expira rapidamente.
   * Deve ser chamado SEMPRE que se abre ou reconecta um WS.
   */
  async getOTP(accountId: string): Promise<{ url: string; wsUrl: string }> {
    try {
      const response = await axios.post<OTPResponse>(
        `${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/otp`,
        {},
        { headers: this.headers, timeout: REQUEST_TIMEOUT },
      );

      const url = response.data?.data?.url;
      if (!url || !url.startsWith('wss://')) {
        throw new Error('URL OTP inválida ou em formato inesperado');
      }

      logger.info('[DerivAPI] OTP obtido', { accountId });
      return { url, wsUrl: url };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.error('[DerivAPI] Falha ao obter OTP', {
          accountId,
          status: error.response?.status,
          data:   error.response?.data,
        });
        throw new Error(
          error.response?.data?.message ?? `Falha ao obter OTP (HTTP ${error.response?.status})`,
        );
      }
      throw error;
    }
  }

  // ── Health Check ─────────────────────────────────────────

  async healthCheck(): Promise<{ status: string }> {
    try {
      const response = await axios.get<{ status: string }>(
        `${DERIV_REST_BASE}/v1/health`,
        { headers: this.headers, timeout: 5_000 },
      );
      return response.data;
    } catch {
      return { status: 'error' };
    }
  }

  // ── Relatório de Comissão (Markup Statistics) ────────────

  /**
   * GET /applications/v1/markup-statistics
   * Estatísticas de markup/comissão de TODAS as apps registadas
   * no token usado, num intervalo de datas. Requer token com
   * scope `application_read` (normalmente o token do dono da
   * app/afiliado, não o do utilizador final — ver
   * DERIV_MARKUP_TOKEN no .env).
   *
   * ATENÇÃO: se o teu token de afiliado tem várias apps
   * associadas (ex: Lucro IA + outros projectos), os totais
   * "total_*" desta resposta somam TODAS elas. Para dados de
   * uma única app, usa getAppMarkupStatistics() abaixo.
   *
   * dateFrom / dateTo no formato "YYYY-MM-DD".
   *
   * Lança DerivTokenExpiredError especificamente quando a causa
   * é o token (401/403/InvalidToken) — outras falhas (rede, 5xx
   * da Deriv) continuam a lançar Error genérico.
   */
  async getMarkupStatistics(dateFrom: string, dateTo: string): Promise<MarkupStatisticsResponse> {
    try {
      const response = await axios.get<MarkupStatisticsResponse>(
        `${DERIV_REST_BASE}/applications/v1/markup-statistics`,
        {
          headers: this.headers,
          params:  { date_from: dateFrom, date_to: dateTo },
          timeout: REQUEST_TIMEOUT,
        },
      );
      logger.info('[DerivAPI] Markup statistics obtidas', { dateFrom, dateTo });
      return response.data;
    } catch (error) {
      if (isTokenError(error)) {
        logger.warn('[DerivAPI] Token de markup rejeitado (expirado/inválido)', {
          status: axios.isAxiosError(error) ? error.response?.status : undefined,
        });
        throw new DerivTokenExpiredError();
      }
      if (axios.isAxiosError(error)) {
        logger.error('[DerivAPI] Falha ao obter markup statistics', {
          status: error.response?.status,
          data:   error.response?.data,
        });
        throw new Error(
          error.response?.data?.errors?.[0]?.message
            ?? error.response?.data?.message
            ?? `Falha ao obter estatísticas de comissão (HTTP ${error.response?.status})`,
        );
      }
      throw error;
    }
  }

  /**
   * Igual a getMarkupStatistics, mas devolve os números de UMA
   * única app (identificada por `appId`), isolada a partir do
   * `breakdown` da resposta. Usa esta função sempre que quiseres
   * mostrar só a comissão da Lucro IA e não a soma de todas as
   * apps do teu token de afiliado.
   *
   * Se a app não aparecer no breakdown (sem movimento no período,
   * ou app_id errado), devolve todos os totais a 0 com
   * `app_found: false` — não é tratado como erro, porque "sem
   * dados neste período" é um resultado válido.
   */
  async getAppMarkupStatistics(
    dateFrom: string,
    dateTo: string,
    appId: string,
  ): Promise<AppMarkupStatistics> {
    const full = await this.getMarkupStatistics(dateFrom, dateTo);
    const entry = full.data.breakdown?.find((b) => String(b.app_id) === String(appId));

    if (!entry) {
      logger.info('[DerivAPI] App não encontrada no breakdown de markup statistics', {
        appId,
        dateFrom,
        dateTo,
        appsNoBreakdown: full.data.breakdown?.map((b) => b.app_id) ?? [],
      });
      return {
        app_id: appId,
        app_found: false,
        total_app_markup_usd: 0,
        total_volume_usd: 0,
        total_payout_usd: 0,
        total_contract_count: 0,
        total_client_count: 0,
      };
    }

    return {
      app_id: appId,
      app_found: true,
      total_app_markup_usd: entry.app_markup_usd ?? 0,
      total_volume_usd: entry.volume_usd ?? 0,
      total_payout_usd: entry.payout_usd ?? 0,
      total_contract_count: entry.contract_count ?? 0,
      total_client_count: entry.client_count ?? 0,
    };
  }

  // ── WebSocket Autenticado (via OTP) ──────────────────────

  /**
   * Cria um WebSocket autenticado usando a URL com OTP.
   *
   * NÃO inclui ping próprio — o server.ts gere o heartbeat
   * da sessão para evitar envios duplicados e rate limit.
   *
   * Callbacks: onMessage, onError, onClose, onOpen
   */
  createAuthenticatedWebSocket(
    wsUrl: string,
    onMessage: (data: Record<string, unknown>) => void,
    onError?:  (error: Error) => void,
    onClose?:  () => void,
    onOpen?:   () => void,
  ): WebSocket {
    logger.info('[DerivAPI] A criar WS autenticado', {
      url: wsUrl.replace(/otp=[^&]+/, 'otp=***'),
    });

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      logger.info('[DerivAPI] WS autenticado conectado');
      onOpen?.();
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        logger.warn('[DerivAPI] Mensagem WS não é JSON');
        return;
      }

      // Ping/pong: silencioso — não passar ao caller
      if (msg.msg_type === 'ping' || msg.msg_type === 'pong') return;

      onMessage(msg);
    });

    ws.on('error', (err: Error) => {
      logger.error('[DerivAPI] Erro no WS autenticado', { message: err.message });
      onError?.(err);
    });

    ws.on('close', () => {
      logger.info('[DerivAPI] WS autenticado fechado');
      onClose?.();
    });

    return ws;
  }

  // ── WebSocket Público (sem autenticação) ─────────────────

  /**
   * Cria um WebSocket público para dados de mercado:
   * ticks, active_symbols, contracts_for, candles, etc.
   *
   * Não requer OTP nem access_token.
   */
  createPublicWebSocket(
    onMessage: (data: Record<string, unknown>) => void,
    onError?:  (error: Error) => void,
    onOpen?:   () => void,
    onClose?:  () => void,
  ): WebSocket {
    const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

    logger.info('[DerivAPI] A criar WS público');
    const ws = new WebSocket(PUBLIC_WS_URL);

    ws.on('open', () => {
      logger.info('[DerivAPI] WS público conectado');
      onOpen?.();
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        logger.warn('[DerivAPI] Mensagem WS público não é JSON');
        return;
      }
      if (msg.msg_type === 'ping' || msg.msg_type === 'pong') return;
      onMessage(msg);
    });

    ws.on('error', (err: Error) => {
      logger.error('[DerivAPI] Erro no WS público', { message: err.message });
      onError?.(err);
    });

    ws.on('close', () => {
      logger.info('[DerivAPI] WS público fechado');
      onClose?.();
    });

    return ws;
  }
}
