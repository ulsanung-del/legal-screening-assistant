const API_BASE = '/api';

const DEFAULT_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 30_000;
const SCREEN_START_TIMEOUT_MS = 10_000;
const POLLING_TIMEOUT_MS = 8_000;
const RESULT_TIMEOUT_MS = 20_000;
const DEMO_API_TOKEN = import.meta.env.VITE_DEMO_API_TOKEN as string | undefined;
const DEMO_TOKEN_HEADER = 'X-Demo-Token';
export const LOCAL_DEMO_MODE = import.meta.env.VITE_LOCAL_DEMO_MODE === 'true';

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type RequestErrorKind = 'aborted' | 'timeout' | 'network';

export class ApiRequestError extends Error {
  public readonly kind: RequestErrorKind;

  constructor(
    message: string,
    kind: RequestErrorKind,
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.kind = kind;
  }
}

export function isAbortRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.kind === 'aborted';
}

export function isTimeoutRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.kind === 'timeout';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOptions = {},
): Promise<Response> {
  const timeoutController = new AbortController();
  const mergedController = new AbortController();

  const onOuterAbort = () => mergedController.abort(signal?.reason);
  const onTimeoutAbort = () => mergedController.abort(new DOMException('timeout', 'AbortError'));

  if (signal) {
    if (signal.aborted) {
      throw new ApiRequestError('요청이 취소되었습니다.', 'aborted');
    }
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  timeoutController.signal.addEventListener('abort', onTimeoutAbort, { once: true });
  const timeoutId = window.setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    const headers = new Headers(init.headers);
    if (DEMO_API_TOKEN) {
      headers.set(DEMO_TOKEN_HEADER, DEMO_API_TOKEN);
    }
    return await fetch(input, { ...init, headers, signal: mergedController.signal });
  } catch (error) {
    if (isAbortError(error)) {
      if (timeoutController.signal.aborted) {
        throw new ApiRequestError(
          `요청 시간이 초과되었습니다 (${Math.round(timeoutMs / 1000)}초).`,
          'timeout',
        );
      }
      throw new ApiRequestError('요청이 취소되었습니다.', 'aborted');
    }
    if (error instanceof TypeError) {
      throw new ApiRequestError('네트워크 연결 상태를 확인해 주세요.', 'network');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    timeoutController.signal.removeEventListener('abort', onTimeoutAbort);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

export interface UploadResponse {
  job_id: string;
  filename: string;
  file_type: string;
  text_preview: string;
  char_count: number;
}

export type JobLifecycleStatus = 'uploaded' | 'processing' | 'completed' | 'failed';

export interface JobStatus {
  job_id: string;
  status: JobLifecycleStatus;
  progress: number;
  current_node: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export type ScreenResponse = JobStatus;

export interface ClauseAnchor {
  clause_id?: string | null;
  heading?: string | null;
  start_offset?: number | null;
  end_offset?: number | null;
}

export interface RiskIssue {
  id: string;
  title: string;
  clause_text: string;
  risk_level: 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  recommendation?: string;
  replacement_clause?: string | null;
  legal_basis?: string | null;
  legal_basis_text?: string | null;
  citations: string[];
  clause_anchor?: ClauseAnchor | null;
}

export interface ScreeningResult {
  job_id: string;
  status: string;
  issues: RiskIssue[];
  verified_issues: RiskIssue[];
  retrieved_docs?: { id: string; category: string; clause: string; content: string }[];
  output_report: string;
  output_email: string;
  full_text?: string;
  masked_text?: string | null;
  contract_masked?: string | null;
  high_risk_count: number;
  medium_risk_count: number;
  low_risk_count: number;
  safety_score: number | null;
}

export interface HealthResponse {
  status: string;
  llm_enabled: boolean;
  rag_enabled: boolean;
  chroma_status: string;
  embedding_model: string;
}

export async function getHealth(options?: RequestOptions): Promise<HealthResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/health`, {}, options);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body?.message) return String(body.message);
    if (body?.detail) {
      if (typeof body.detail === 'string') return body.detail;
      if (body.detail?.message) return String(body.detail.message);
    }
  } catch {
    /* ignore */
  }
  return res.statusText || `HTTP ${res.status}`;
}

export async function uploadContract(file: File, options?: RequestOptions): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetchWithTimeout(
    `${API_BASE}/upload`,
    { method: 'POST', body: form },
    { timeoutMs: UPLOAD_TIMEOUT_MS, ...options },
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function runScreen(jobId: string, options?: RequestOptions): Promise<JobStatus> {
  const res = await fetchWithTimeout(
    `${API_BASE}/screen`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    },
    { timeoutMs: LOCAL_DEMO_MODE ? RESULT_TIMEOUT_MS : SCREEN_START_TIMEOUT_MS, ...options },
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function getJobStatus(jobId: string, options?: RequestOptions): Promise<JobStatus> {
  const res = await fetchWithTimeout(
    `${API_BASE}/jobs/${jobId}`,
    {},
    { timeoutMs: POLLING_TIMEOUT_MS, ...options },
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function getResult(jobId: string, options?: RequestOptions): Promise<ScreeningResult> {
  const res = await fetchWithTimeout(
    `${API_BASE}/result/${jobId}`,
    {},
    { timeoutMs: RESULT_TIMEOUT_MS, ...options },
  );
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
