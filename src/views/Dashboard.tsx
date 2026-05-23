import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  isAbortRequestError,
  isTimeoutRequestError,
  LOCAL_DEMO_MODE,
  type JobLifecycleStatus,
  type ScreeningResult,
} from '../api/client';
import { MaskingCompare } from '../components/MaskingCompare';
import { clearScreeningQueries, useJobStatus, useScreeningResult, useStartScreening } from '../hooks/useScreening';
import {
  buildBlocksFromContract,
  mapResultToContractData,
  type ContractBlock,
  type UploadMeta,
} from '../lib/mapScreeningResult';
import { koreanHeadings } from '../constants/uiLabels';
import type { ContractData } from '../types/contract';
import { Card, CardHeader, CardTitle, CardDescription } from '../components/Card';
import { Badge } from '../components/Badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '../components/Table';
import { Accordion, AccordionItem } from '../components/Accordion';
import { 
  AlertTriangle, 
  FileText, 
  CheckCircle2, 
  Sparkles, 
  Upload, 
  RefreshCw, 
  Search, 
  FileCheck,
  ChevronRight,
  Info,
  Copy,
  Undo,
  Check,
  Activity,
  ShieldAlert
} from 'lucide-react';

type WordDiffPart = { type: 'added' | 'removed' | 'common', text: string };

const MAX_DIFF_WORDS = 800;
const EMPTY_RISKS: ContractData['risks'] = [];

function getScoreInfo(score: number) {
  if (score >= 90) return { label: '최상 (Excellent)', color: 'text-emerald-600', stroke: '#10b981' };
  if (score >= 70) return { label: '양호 (Good)', color: 'text-sky-600', stroke: '#3b82f6' };
  if (score >= 50) return { label: '주의 (Caution)', color: 'text-amber-600', stroke: '#f59e0b' };
  return { label: '위험 (Warning)', color: 'text-rose-600', stroke: '#ef4444' };
}

// Client-side lightweight word-level LCS (Longest Common Subsequence) diff utility
function computeWordDiff(str1: string, str2: string): WordDiffPart[] {
  // Normalize whitespaces but keep structure
  const words1 = str1.split(/(\s+)/).filter(w => w.length > 0);
  const words2 = str2.split(/(\s+)/).filter(w => w.length > 0);

  if (words1.length > MAX_DIFF_WORDS || words2.length > MAX_DIFF_WORDS) {
    return [
      { type: 'removed', text: str1 },
      { type: 'added', text: str2 },
    ];
  }
  
  const dp: number[][] = Array(words1.length + 1).fill(0).map(() => Array(words2.length + 1).fill(0));
  
  for (let i = 1; i <= words1.length; i++) {
    for (let j = 1; j <= words2.length; j++) {
      if (words1[i - 1] === words2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  const diff: WordDiffPart[] = [];
  let i = words1.length, j = words2.length;
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && words1[i - 1] === words2[j - 1]) {
      diff.unshift({ type: 'common', text: words1[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'added', text: words2[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      diff.unshift({ type: 'removed', text: words1[i - 1] });
      i--;
    }
  }
  
  return diff;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 50;
const ALLOWED_UPLOAD_EXTENSIONS = new Set(['txt', 'pdf', 'docx']);
const ALLOWED_UPLOAD_MIME_TYPES: Record<string, Set<string>> = {
  txt: new Set(['text/plain']),
  pdf: new Set(['application/pdf']),
  docx: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
};

const ANALYSIS_STEPS = [
  { phase: 1, label: '계약서 구조 분석 및 민감 정보 마스킹' },
  { phase: 2, label: '유사 판례 및 위험 조항 검토' },
  { phase: 3, label: '책임 범위 및 독소 조항 분류' },
  { phase: 4, label: '수정 권고안 및 대체 조항 생성' },
] as const;

type AnalysisPhase = 1 | 2 | 3 | 4 | 5;

const NODE_PHASE_MAP: Record<string, AnalysisPhase> = {
  screening: 1,
  parser: 1,
  masker: 1,
  init: 1,
  law_context: 2,
  langgraph: 2,
  rag_retriever: 2,
  screener: 3,
  guardrail: 3,
  generator: 4,
  demasker: 4,
  completed: 5,
};

const DEMO_READY_KEY = 'deepgle_demo_ready';

function resolveAnalysisPhase(
  currentNode: string | null | undefined,
  jobStatus: JobLifecycleStatus | undefined,
  elapsedMs: number,
): AnalysisPhase {
  if (jobStatus === 'completed') return 5;
  if (currentNode && NODE_PHASE_MAP[currentNode]) return NODE_PHASE_MAP[currentNode];
  if (LOCAL_DEMO_MODE) {
    if (elapsedMs < 800) return 1;
    if (elapsedMs < 1800) return 2;
    if (elapsedMs < 4000) return 3;
    return 4;
  }
  if (elapsedMs < 2500) return 1;
  if (elapsedMs < 6000) return 2;
  if (elapsedMs < 12000) return 3;
  return 4;
}

function getStatusHeadline(phase: AnalysisPhase, isWarmup: boolean): string {
  if (isWarmup && phase === 1) return '초기 분석 환경을 준비하고 있습니다...';
  switch (phase) {
    case 1:
      return '계약서 구조를 분석하고 있습니다...';
    case 2:
      return '위험 가능성이 높은 조항을 식별하고 있습니다...';
    case 3:
      return '책임 범위와 독소 조항을 분류하고 있습니다...';
    case 4:
      return '수정 권고안을 생성하고 있습니다...';
    default:
      return '최종 분석 결과를 정리하고 있습니다...';
  }
}

function getAuxiliaryMessage(elapsedMs: number): string | null {
  if (LOCAL_DEMO_MODE) {
    if (elapsedMs >= 12000) return '완료 상태를 확인하는 중입니다.';
    return null;
  }
  if (elapsedMs >= 20000) return '거의 완료되었습니다. 결과를 정리하고 있습니다.';
  if (elapsedMs >= 10000) return '계약 조항 수가 많아 분석에 시간이 더 소요되고 있습니다.';
  return null;
}

function getProgressTarget(
  phase: AnalysisPhase,
  elapsedMs: number,
  backendProgress: number,
): number {
  const ceilings = [15, 45, 75, 95, 98] as const;
  const floor = phase === 1 ? 0 : ceilings[phase - 2];
  const ceiling = ceilings[phase - 1];
  const phaseWindowMs = LOCAL_DEMO_MODE ? 2000 : 8000;
  const phaseElapsed = elapsedMs % phaseWindowMs;
  const creepRatio = LOCAL_DEMO_MODE ? 0.8 : 0.35;
  const creep = (phaseElapsed / phaseWindowMs) * (ceiling - floor) * creepRatio;
  const timeBased = floor + creep;
  const backendBased = backendProgress > 0 ? backendProgress : timeBased;
  return Math.min(ceiling, Math.max(timeBased, backendBased * (LOCAL_DEMO_MODE ? 0.99 : 0.95)));
}

function hasCompletedDemoBefore(): boolean {
  try {
    return Boolean(sessionStorage.getItem(DEMO_READY_KEY));
  } catch {
    return true;
  }
}

function markDemoReady(): void {
  try {
    sessionStorage.setItem(DEMO_READY_KEY, '1');
  } catch {
    // sessionStorage unavailable
  }
}

function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() || '';
}

function formatBytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))}MB`;
}

async function estimatePdfPageCount(file: File): Promise<number> {
  const text = new TextDecoder('latin1').decode(await file.arrayBuffer());
  return text.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

async function validateUploadFile(file: File): Promise<void> {
  const ext = getFileExtension(file.name);
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    throw new Error('지원하지 않는 파일 형식입니다. PDF, DOCX, TXT 파일만 업로드해 주세요.');
  }
  if (file.size === 0) {
    throw new Error('빈 파일은 업로드할 수 없습니다.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`파일 크기는 ${formatBytes(MAX_UPLOAD_BYTES)} 이하여야 합니다.`);
  }

  const allowedMimeTypes = ALLOWED_UPLOAD_MIME_TYPES[ext];
  if (file.type && file.type !== 'application/octet-stream' && !allowedMimeTypes.has(file.type)) {
    throw new Error(`파일 MIME 타입이 올바르지 않습니다. 감지: ${file.type}`);
  }

  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (ext === 'pdf') {
    const signature = String.fromCharCode(...header.slice(0, 5));
    if (signature !== '%PDF-') throw new Error('PDF 파일 서명이 올바르지 않습니다.');
    const pageCount = await estimatePdfPageCount(file);
    if (pageCount > MAX_PDF_PAGES) {
      throw new Error(`PDF는 최대 ${MAX_PDF_PAGES}페이지까지 업로드할 수 있습니다.`);
    }
  }
  if (ext === 'docx') {
    if (!(header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04)) {
      throw new Error('DOCX 파일 서명이 올바르지 않습니다.');
    }
  }
  if (ext === 'txt' && header.includes(0)) {
    throw new Error('TXT 파일에 바이너리 데이터가 포함되어 있습니다.');
  }
}

export const Dashboard: React.FC = () => {
  const queryClient = useQueryClient();
  const [isAnalyzed, setIsAnalyzed] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'viewer'>('overview');
  const [selectedRiskId, setSelectedRiskId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [animatedProgress, setAnimatedProgress] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isWarmupSession] = useState(() => !hasCompletedDemoBefore());
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploadMeta, setUploadMeta] = useState<UploadMeta | null>(null);
  const [apiContract, setApiContract] = useState<ContractData | null>(null);
  const [apiScreening, setApiScreening] = useState<ScreeningResult | null>(null);
  const startScreeningMutation = useStartScreening();
  const jobStatusQuery = useJobStatus(jobId);
  const screeningResultQuery = useScreeningResult(jobId, jobStatusQuery.data?.status);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const finishUploadTimerRef = useRef<number | null>(null);
  const shineBlockTimerRef = useRef<number | null>(null);
  const processingStartedAtRef = useRef<number | null>(null);
  const progressRafRef = useRef<number | null>(null);
  const flowVersionRef = useRef(0);
  const isUnmountedRef = useRef(false);
  const [diffViewMode, setDiffViewMode] = useState<'side-by-side' | 'redline'>('redline');
  const [shineBlockId, setShineBlockId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<ContractBlock[]>([]);
  const currentJobIdRef = useRef<string | null>(null);
  const jobLifecycleStatus = jobStatusQuery.data?.status;
  const currentNode = jobStatusQuery.data?.current_node;
  const pollingProgress = jobStatusQuery.data?.progress ?? 0;

  const analysisPhase = useMemo(() => {
    if (!isUploading) return 1 as AnalysisPhase;
    return resolveAnalysisPhase(currentNode, jobLifecycleStatus, elapsedMs);
  }, [currentNode, elapsedMs, isUploading, jobLifecycleStatus]);

  const displayStep = Math.min(4, analysisPhase);
  const progressPercent = isUploading
    ? Math.max(3, Math.min(100, animatedProgress))
    : 0;

  const statusHeadline = getStatusHeadline(analysisPhase, isWarmupSession);
  const auxiliaryMessage = isUploading ? getAuxiliaryMessage(elapsedMs) : null;

  const previewStep = useMemo(() => {
    if (!isUploading || analysisPhase >= 4) return null;
    const phaseStartEstimate = [0, 2500, 6000, 12000][analysisPhase - 1] ?? 0;
    if (elapsedMs - phaseStartEstimate > 5000) {
      return Math.min(4, analysisPhase + 1);
    }
    return null;
  }, [analysisPhase, elapsedMs, isUploading]);

  const clearPendingTimers = () => {
    if (finishUploadTimerRef.current !== null) {
      window.clearTimeout(finishUploadTimerRef.current);
      finishUploadTimerRef.current = null;
    }
    if (shineBlockTimerRef.current !== null) {
      window.clearTimeout(shineBlockTimerRef.current);
      shineBlockTimerRef.current = null;
    }
    if (progressRafRef.current !== null) {
      cancelAnimationFrame(progressRafRef.current);
      progressRafRef.current = null;
    }
  };

  const canApplyUploadState = () => !isUnmountedRef.current;

  useEffect(() => {
    currentJobIdRef.current = jobId;
  }, [jobId]);

  const finishUploadUi = () => {
    if (!canApplyUploadState()) return;
    clearPendingTimers();
    markDemoReady();
    setAnimatedProgress(100);
    setIsUploading(false);
    setUploadSuccess(true);
    processingStartedAtRef.current = null;
    finishUploadTimerRef.current = window.setTimeout(() => {
      if (!canApplyUploadState()) return;
      setUploadSuccess(false);
      setAnimatedProgress(0);
      setElapsedMs(0);
      finishUploadTimerRef.current = null;
    }, LOCAL_DEMO_MODE ? 800 : 3000);
  };

  useEffect(() => {
    return () => {
      isUnmountedRef.current = true;
      flowVersionRef.current += 1;
      startScreeningMutation.cancelStartRequest();
      void clearScreeningQueries(queryClient, currentJobIdRef.current);
      clearPendingTimers();
    };
  }, [queryClient, startScreeningMutation.cancelStartRequest]);

  useEffect(() => {
    if (!isUploading) {
      setElapsedMs(0);
      processingStartedAtRef.current = null;
      return;
    }
    if (processingStartedAtRef.current === null) {
      processingStartedAtRef.current = Date.now();
    }
    const tick = () => {
      if (processingStartedAtRef.current !== null) {
        setElapsedMs(Date.now() - processingStartedAtRef.current);
      }
    };
    tick();
    const intervalId = window.setInterval(tick, 500);
    return () => window.clearInterval(intervalId);
  }, [isUploading]);

  useEffect(() => {
    if (!isUploading) {
      setAnimatedProgress(0);
      if (progressRafRef.current !== null) {
        cancelAnimationFrame(progressRafRef.current);
        progressRafRef.current = null;
      }
      return;
    }

    const animate = () => {
      const target = getProgressTarget(analysisPhase, elapsedMs, pollingProgress);
      setAnimatedProgress((prev) => {
        const delta = target - prev;
        if (Math.abs(delta) < 0.15) return target;
        return prev + delta * (LOCAL_DEMO_MODE ? 0.45 : 0.12);
      });
      progressRafRef.current = requestAnimationFrame(animate);
    };

    progressRafRef.current = requestAnimationFrame(animate);
    return () => {
      if (progressRafRef.current !== null) {
        cancelAnimationFrame(progressRafRef.current);
        progressRafRef.current = null;
      }
    };
  }, [analysisPhase, elapsedMs, isUploading, pollingProgress]);

  useEffect(() => {
    if (!isUploading) return;
  }, [displayStep, isUploading]);

  useEffect(() => {
    const status = jobStatusQuery.data;
    if (!isUploading || !jobId || !status || status.job_id !== jobId) return;
    if (!canApplyUploadState()) return;

    if (status.status === 'failed') {
      setIsUploading(false);
      setAnimatedProgress(0);
      setElapsedMs(0);
      processingStartedAtRef.current = null;
      setUploadError(status.error || '계약서 분석 작업이 실패했습니다.');
    }
  }, [isUploading, jobId, jobStatusQuery.data]);

  useEffect(() => {
    if (!jobStatusQuery.error || !isUploading || !jobId) return;
    if (!canApplyUploadState()) return;
    if (isAbortRequestError(jobStatusQuery.error) || isTimeoutRequestError(jobStatusQuery.error)) {
      return;
    }
    setIsUploading(false);
    setAnimatedProgress(0);
    setElapsedMs(0);
    processingStartedAtRef.current = null;
    setUploadError(
      jobStatusQuery.error instanceof Error
        ? jobStatusQuery.error.message
        : '스크리닝 작업 상태를 확인하지 못했습니다.',
    );
  }, [isUploading, jobId, jobStatusQuery.error]);

  useEffect(() => {
    if (!screeningResultQuery.error || !isUploading || !jobId) return;
    if (!canApplyUploadState()) return;
    if (
      isAbortRequestError(screeningResultQuery.error) ||
      isTimeoutRequestError(screeningResultQuery.error)
    ) {
      return;
    }
    setIsUploading(false);
    setAnimatedProgress(0);
    setElapsedMs(0);
    processingStartedAtRef.current = null;
    setUploadError(
      screeningResultQuery.error instanceof Error
        ? screeningResultQuery.error.message
        : '스크리닝 결과를 불러오지 못했습니다.',
    );
  }, [isUploading, jobId, screeningResultQuery.error]);

  useEffect(() => {
    const screening = screeningResultQuery.data;
    if (!screening || !uploadMeta || !jobId || screening.job_id !== jobId) return;
    if (apiScreening?.job_id === screening.job_id) return;
    if (!canApplyUploadState()) return;

    setAnimatedProgress(98);
    setApiScreening(screening);
    const mapped = mapResultToContractData(screening, uploadMeta);
    setApiContract(mapped);
    setBlocks(buildBlocksFromContract(mapped));
    if (mapped.risks[0]) setSelectedRiskId(mapped.risks[0].id);
    finishUploadUi();
    setIsAnalyzed(true);
    setActiveTab('overview');
  }, [apiScreening?.job_id, jobId, screeningResultQuery.data, uploadMeta]);

  const runUploadFlow = async (file: File) => {
    if (isUploading) return;
    const flowVersion = flowVersionRef.current + 1;
    flowVersionRef.current = flowVersion;
    clearPendingTimers();
    setUploadError(null);
    setIsUploading(true);
    setUploadSuccess(false);
    setAnimatedProgress(3);
    setElapsedMs(0);
    processingStartedAtRef.current = Date.now();
    try {
      await validateUploadFile(file);
    } catch (err) {
      if (isUnmountedRef.current || flowVersionRef.current !== flowVersion) return;
      setIsUploading(false);
      setAnimatedProgress(0);
      setElapsedMs(0);
      processingStartedAtRef.current = null;
      setUploadSuccess(false);
      setUploadError(
        err instanceof Error ? err.message : '업로드할 수 없는 파일입니다.',
      );
      return;
    }

    await clearScreeningQueries(queryClient, currentJobIdRef.current);
    if (isUnmountedRef.current || flowVersionRef.current !== flowVersion) return;
    setJobId(null);
    setUploadMeta(null);
    try {
      setAnimatedProgress(8);
      const data = await startScreeningMutation.mutateAsync(file);
      if (isUnmountedRef.current || flowVersionRef.current !== flowVersion) return;
      setJobId(data.upload.job_id);
      setUploadMeta(data.uploadMeta);
    } catch (err) {
      if (isUnmountedRef.current || flowVersionRef.current !== flowVersion) return;
      if (isAbortRequestError(err)) return;
      setIsUploading(false);
      setAnimatedProgress(0);
      setElapsedMs(0);
      processingStartedAtRef.current = null;
      const message = isTimeoutRequestError(err)
        ? '업로드 요청 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.'
        : err instanceof Error
          ? err.message
          : '업로드 또는 스크리닝에 실패했습니다.';
      setUploadError(
        message,
      );
    }
  };

  const handleUpload = () => {
    if (isUploading) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void runUploadFlow(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (isUploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void runUploadFlow(file);
  };

  // Reset to home view to analyze another contract
  const handleReset = () => {
    flowVersionRef.current += 1;
    startScreeningMutation.cancelStartRequest();
    void clearScreeningQueries(queryClient, currentJobIdRef.current);
    clearPendingTimers();
    setShineBlockId(null);
    setIsAnalyzed(false);
    setApiContract(null);
    setApiScreening(null);
    setJobId(null);
    setUploadMeta(null);
    setIsUploading(false);
    setBlocks([]);
    setSelectedRiskId('');
    setSearchTerm('');
    setAnimatedProgress(0);
    setElapsedMs(0);
    processingStartedAtRef.current = null;
    setUploadSuccess(false);
    setUploadError(null);
    startScreeningMutation.reset();
  };

  // Direct edit: apply the recommendation to the document block text
  const handleApplyRecommendation = (riskId: string, recommendationText: string) => {
    setBlocks(prev => prev.map(block => {
      if (block.riskId === riskId) {
        // Find clause number from original block text to prefix
        const originalFirstLine = block.originalText?.split('\n')[0] || '';
        const match = originalFirstLine.match(/^(제\d+조\s*(\([^)]+\))?)/);
        const prefix = match ? match[1] + '\n' : '';
        
        return {
          ...block,
          text: prefix + recommendationText,
          isResolved: true
        };
      }
      return block;
    }));

    // Trigger visual shine micro-animation on the document block
    if (shineBlockTimerRef.current !== null) {
      window.clearTimeout(shineBlockTimerRef.current);
    }
    setShineBlockId(riskId);
    shineBlockTimerRef.current = window.setTimeout(() => {
      if (!canApplyUploadState()) return;
      setShineBlockId(null);
      shineBlockTimerRef.current = null;
    }, 1000);
  };

  // Direct edit: revert to original clause
  const handleRevertClause = (riskId: string) => {
    setBlocks(prev => prev.map(block => {
      if (block.riskId === riskId) {
        return {
          ...block,
          text: block.originalText || block.text,
          isResolved: false
        };
      }
      return block;
    }));
  };

  const contractRisks = apiContract?.risks ?? EMPTY_RISKS;

  const blocksByRiskId = useMemo(() => {
    const map = new Map<string, ContractBlock>();
    for (const block of blocks) {
      if (block.riskId) map.set(block.riskId, block);
    }
    return map;
  }, [blocks]);

  const risksById = useMemo(() => {
    const map = new Map<string, ContractData['risks'][number]>();
    for (const risk of contractRisks) {
      map.set(risk.id, risk);
    }
    return map;
  }, [contractRisks]);

  const activeRisks = useMemo(() => (
    contractRisks.filter(risk => {
      const block = blocksByRiskId.get(risk.id);
      return block && !block.isResolved;
    })
  ), [blocksByRiskId, contractRisks]);

  const resolvedCount = useMemo(
    () => blocks.filter(block => block.isRisk && block.isResolved).length,
    [blocks],
  );

  const highRiskCount = useMemo(
    () => apiScreening?.high_risk_count ?? activeRisks.filter(risk => risk.severity === 'high').length,
    [activeRisks, apiScreening?.high_risk_count],
  );
  const mediumRiskCount = useMemo(
    () => apiScreening?.medium_risk_count ?? activeRisks.filter(risk => risk.severity === 'medium').length,
    [activeRisks, apiScreening?.medium_risk_count],
  );
  const lowRiskCount = useMemo(
    () => apiScreening?.low_risk_count ?? activeRisks.filter(risk => risk.severity === 'low').length,
    [activeRisks, apiScreening?.low_risk_count],
  );

  const safetyScore = useMemo(() => {
    const maxScore = 100;
    const penalty = highRiskCount * 25 + mediumRiskCount * 12 + lowRiskCount * 5;
    return apiScreening?.safety_score ?? Math.max(0, maxScore - penalty);
  }, [apiScreening?.safety_score, highRiskCount, lowRiskCount, mediumRiskCount]);

  const scoreInfo = useMemo(() => getScoreInfo(safetyScore), [safetyScore]);

  const selectedRisk = risksById.get(selectedRiskId);
  const selectedBlock = blocksByRiskId.get(selectedRiskId);

  const filteredRisksList = useMemo(() => {
    const query = searchTerm.toLowerCase();
    if (!query) return contractRisks;
    return contractRisks.filter(risk => (
      risk.clauseName.toLowerCase().includes(query) ||
      risk.summary.toLowerCase().includes(query) ||
      risk.category.toLowerCase().includes(query)
    ));
  }, [contractRisks, searchTerm]);

  const selectedDiffParts = useMemo(() => {
    if (activeTab !== 'viewer' || diffViewMode !== 'redline') return null;
    if (!selectedBlock?.originalText || !selectedRisk?.recommendation) return null;

    const origClean = selectedBlock.originalText.replace(/^(\d+\.\s+)/, '');
    return computeWordDiff(origClean, selectedRisk.recommendation);
  }, [activeTab, diffViewMode, selectedBlock?.originalText, selectedRisk?.recommendation]);

  if (!isAnalyzed) {
    return (
      <div className="w-full max-w-4xl mx-auto space-y-12 py-8 animate-fade-in-up">
        {/* 헤더 안내 영역 */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center gap-1.5 bg-navy-50 text-navy-800 px-3.5 py-1.5 rounded-full border border-navy-100 text-xs font-medium tracking-wide mb-2">
            <Activity className="w-3.5 h-3.5" />
            계약 분석
          </div>
          <h1 className="text-4xl font-semibold text-slate-900 leading-tight tracking-tight">
            계약서 검토 보조 시스템
          </h1>
          <p className="text-sm text-slate-600 max-w-xl mx-auto leading-relaxed">
            비밀유지계약서(NDA) 등 상거래 계약서를 업로드하면 민감 정보 마스킹 후 주요 위험 조항과 수정 권고안을 확인할 수 있습니다. 본 결과는 법무 검토 보조를 위한 참고 자료입니다.
          </p>
        </div>

        {/* 대형 업로드 영역 */}
        <div className="max-w-2xl mx-auto">
          <Card variant="dashboard" className="flex flex-col justify-between border-dashed border-2 hover:border-navy-800/40 p-8 min-h-[380px] radial-glow-navy transition-all duration-300 group shadow-sm bg-white">
            <div className="space-y-6">
              <CardHeader className="p-0 text-center">
                <div className="mx-auto w-12 h-12 rounded-xl bg-navy-800/5 text-navy-800 flex items-center justify-center mb-3 group-hover:scale-105 group-hover:bg-navy-800/10 transition-all duration-300">
                  <Upload className="w-6 h-6" />
                </div>
                <CardTitle className="text-xl font-bold text-slate-800">계약서 분석 시작</CardTitle>
                <CardDescription className="text-xs leading-relaxed max-w-md mx-auto mt-1">
                  PDF, DOCX, TXT 파일을 업로드하면 마스킹, 조항 분석, 수정 권고 생성 단계가 순차적으로 실행됩니다.
                </CardDescription>
              </CardHeader>

              {uploadError && !isUploading && (
                <div
                  role="alert"
                  className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-left flex gap-3 items-start"
                >
                  <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
                  <div className="space-y-2 flex-1">
                    <p className="text-sm font-bold text-rose-900">계약서 분석에 실패했습니다</p>
                    <p className="text-xs text-rose-800 leading-relaxed">{uploadError}</p>
                    <p className="text-[11px] text-rose-700">
                      분석 서버가 실행 중인지 확인한 뒤, PDF·DOCX·TXT 파일로 다시 시도해 주세요.
                    </p>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setUploadError(null);
                      }}
                      className="text-xs font-bold text-rose-900 underline hover:text-rose-700"
                    >
                      닫기
                    </button>
                  </div>
                </div>
              )}
              
              {/* Interactive Upload Dropzone or Sequential Process Loading State */}
              <div 
                className="border border-slate-200 border-dashed rounded-2xl p-6 bg-slate-50/50 text-center flex flex-col items-center justify-center cursor-pointer transition-all duration-300 hover:bg-slate-100/50 focus-within:ring-2 focus-within:ring-navy-800/20"
                onClick={handleUpload}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.txt"
                  className="hidden"
                  onChange={handleFileChange}
                />
                {isUploading ? (
                  <div className="flex flex-col items-start w-full gap-4 py-2 px-1 select-none animate-slide-in">
                    <div className="flex flex-col items-center gap-1.5 w-full justify-center min-h-[2.5rem]">
                      <div className="flex items-center gap-2">
                        <RefreshCw className="w-4 h-4 text-navy-800 animate-spin shrink-0" />
                        <span
                          key={statusHeadline}
                          className="text-xs font-semibold text-slate-700 animate-fade-in-up"
                        >
                          {statusHeadline}
                        </span>
                      </div>
                      {auxiliaryMessage && (
                        <p
                          key={auxiliaryMessage}
                          className="text-[11px] text-slate-500 font-medium text-center animate-fade-in-up"
                        >
                          {auxiliaryMessage}
                        </p>
                      )}
                    </div>
                    <div className="space-y-3.5 w-full max-w-md mx-auto text-left py-2">
                      {ANALYSIS_STEPS.map((step) => {
                        const isComplete = displayStep > step.phase;
                        const isActive = displayStep === step.phase;
                        const isPreview = previewStep === step.phase;
                        return (
                          <div
                            key={step.phase}
                            className={`flex items-center gap-2.5 transition-opacity duration-500 ${
                              isPreview && !isActive && !isComplete ? 'opacity-70' : 'opacity-100'
                            }`}
                          >
                            <span
                              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 transition-colors duration-300 ${
                                isComplete
                                  ? 'bg-emerald-500 text-white'
                                  : isActive
                                    ? 'bg-navy-800 text-white'
                                    : isPreview
                                      ? 'bg-navy-200 text-navy-700'
                                      : 'bg-slate-200 text-slate-500'
                              } ${isActive ? 'ring-2 ring-navy-800/15' : ''}`}
                            >
                              {isComplete ? <Check className="w-3 h-3" /> : step.phase}
                            </span>
                            <span
                              className={`text-xs font-medium leading-5 transition-colors duration-300 ${
                                isActive
                                  ? 'text-navy-800'
                                  : isComplete
                                    ? 'text-slate-400'
                                    : isPreview
                                      ? 'text-slate-500'
                                      : 'text-slate-300'
                              }`}
                            >
                              {step.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden mt-1 max-w-md mx-auto relative">
                      <div
                        className={`bg-navy-800 h-full rounded-full progress-bar-fill transition-[width] ease-out ${
                          LOCAL_DEMO_MODE ? 'duration-75' : 'duration-200'
                        }`}
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                ) : uploadSuccess ? (
                  <div className="flex flex-col items-center gap-3 py-6 animate-scale-in">
                    <div className="w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-500 animate-pulse-ring">
                      <Check className="w-7 h-7" />
                    </div>
                    <span className="text-sm font-bold text-slate-800">계약서 분석 완료</span>
                    <span className="text-xs text-emerald-700 font-semibold bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full">
                      분석 결과 리포트 준비 완료
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-10">
                    <FileText className="w-12 h-12 text-slate-400 group-hover:text-navy-800 group-hover:scale-105 transition-all duration-300 mb-4" />
                    <span className="text-sm font-bold text-slate-800">마우스 클릭 또는 드래그하여 계약서 업로드</span>
                    <span className="text-[11px] text-slate-500 mt-2">지원 형식: PDF, DOCX, TXT (최대 10MB)</span>
                  </div>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 mt-6 flex items-center justify-center gap-1.5 text-xs text-slate-600 font-semibold text-center leading-relaxed">
              <Info className="w-4 h-4 text-navy-800 shrink-0" />
              <span>민감 정보 마스킹 후 계약 분석을 수행합니다. 업로드 문서는 처리 과정에서 일시적으로 보관될 수 있습니다.</span>
            </div>
          </Card>
        </div>

        {/* 주요 핵심 기능 그리드 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 pt-6">
          <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-sm text-center space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center mx-auto border border-rose-100">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-slate-900 text-sm">위험 조항 검출</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              면책 조항, 무제한 손해배상 등 편면적인 계약 요소를 분석하고 표시합니다.
            </p>
          </div>

          <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-sm text-center space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-navy-50 text-navy-800 flex items-center justify-center mx-auto border border-navy-100">
              <Sparkles className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-slate-900 text-sm">수정 권고안</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              상법 및 표준 계약서를 참고하여 검토에 활용할 수 있는 수정 권고안을 제안합니다.
            </p>
          </div>

          <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-sm text-center space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto border border-emerald-100">
              <FileCheck className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-slate-900 text-sm">단어 단위 레드라인</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              수정 전후 계약 조항의 삭제/추가된 문구를 색상별 인라인 비교로 쉽게 대조합니다.
            </p>
          </div>

          <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-sm text-center space-y-2.5">
            <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center mx-auto border border-sky-100">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <h3 className="font-bold text-slate-900 text-sm">안전성 점수 진단</h3>
            <p className="text-xs text-slate-500 leading-relaxed">
              리스크 심각도를 합산한 계약 리스크 점수(0~100)입니다. 최종 법적 판단을 대체하지 않습니다.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!apiContract || !apiScreening) {
    return (
      <div className="w-full max-w-lg mx-auto py-16 text-center space-y-4 animate-fade-in-up">
        <ShieldAlert className="w-12 h-12 text-amber-600 mx-auto" />
        <h2 className="text-xl font-bold text-slate-900">분석 결과를 불러오지 못했습니다</h2>
        <p className="text-sm text-slate-600">
          서버 응답이 비어 있거나 세션이 만료되었을 수 있습니다. 계약서를 다시 업로드해 주세요.
        </p>
        <button
          type="button"
          onClick={handleReset}
          className="px-5 py-2.5 bg-navy-800 text-white rounded-xl text-sm font-bold hover:bg-navy-900 transition-colors"
        >
          업로드 화면으로 돌아가기
        </button>
      </div>
    );
  }

  const contract = apiContract;

  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (safetyScore / 100) * circumference;

  const renderWordDiff = (diffs: WordDiffPart[] | null) => {
    if (!diffs) return null;

    return (
      <div className="p-4 bg-slate-50/70 border border-slate-200/80 rounded-xl text-sm font-sans text-slate-800 leading-7 max-h-72 overflow-y-auto tracking-normal whitespace-pre-wrap select-text">
        {diffs.map((part, index) => {
          if (part.type === 'added') {
            return (
              <span key={index} className="diff-word-add mx-0.5">
                {part.text}
              </span>
            );
          }
          if (part.type === 'removed') {
            return (
              <span key={index} className="diff-word-del mx-0.5">
                {part.text}
              </span>
            );
          }
          return <span key={index} className="opacity-90">{part.text}</span>;
        })}
      </div>
    );
  };

  return (
    <div className="w-full max-w-7xl mx-auto space-y-8 animate-fade-in-up">
      
      {/* Top Banner Dashboard Actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200/80 pb-6">
        <div>
          <div className="inline-flex items-center gap-1.5 bg-navy-50 text-navy-800 px-3 py-1 rounded-full border border-navy-100 text-xs font-medium tracking-wide mb-2">
            <Activity className="w-3.5 h-3.5" />
            계약 분석
          </div>
          <h1 className="text-3xl font-semibold text-slate-900 leading-tight tracking-tight">
            {koreanHeadings.dashboardTitle}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            NDA 및 상거래 계약서의 위험 조항과 배상 한도를 분석하고 수정 권고안을 제시합니다. 법무 검토 보조를 위한 참고 자료입니다.
          </p>
        </div>

        {/* View Switcher Controls & Reset Button */}
        <div className="flex flex-wrap items-center gap-3 self-start">
          <div className="flex items-center gap-1.5 bg-slate-200/50 p-1.5 rounded-xl border border-slate-200/60 shadow-sm">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-4 py-2 rounded-lg text-xs font-bold tracking-wide transition-all duration-300 cursor-pointer ${
                activeTab === 'overview'
                  ? 'bg-white text-navy-800 shadow-sm border border-slate-200/50'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              분석 요약
            </button>
            <button
              onClick={() => setActiveTab('viewer')}
              className={`px-4 py-2 rounded-lg text-xs font-bold tracking-wide transition-all duration-300 flex items-center gap-2 cursor-pointer ${
                activeTab === 'viewer'
                  ? 'bg-white text-navy-800 shadow-sm border border-slate-200/50'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              문서 검토
            </button>
          </div>
          
          <button
            onClick={handleReset}
            className="px-4 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-700 rounded-xl text-xs font-bold transition-all duration-300 shadow-sm flex items-center gap-1.5 cursor-pointer active:scale-98"
          >
            <RefreshCw className="w-3.5 h-3.5 text-slate-500" />
            다른 계약서 분석하기
          </button>
        </div>
      </div>

      {/* VIEW 1: OVERVIEW DASHBOARD */}
      {activeTab === 'overview' && (
        <div className="space-y-8 animate-fade-in-up">
          
          {/* Key Metrics Dashboard Grid (Includes Circular Gauge Safety Summary) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
            
            {/* dynamic Circular Safety Gauge (Takes 5 Cols on desktop) */}
            <Card variant="dashboard" className="lg:col-span-5 flex flex-col justify-between overflow-hidden relative group radial-glow-navy p-6 select-none">
              <div className="absolute top-0 right-0 w-32 h-32 bg-slate-100/10 rounded-bl-full pointer-events-none"></div>
              
              <CardHeader className="p-0 mb-4">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-navy-600"></span>
                  <CardTitle className="text-base font-bold text-slate-800">계약 안전성 종합 레포트</CardTitle>
                </div>
                <CardDescription className="text-xs">
                  검출된 리스크 심각도를 기준으로 계산한 계약 리스크 점수입니다. 법무 검토 보조를 위한 참고 자료이며 최종 법적 판단을 대체하지 않습니다.
                </CardDescription>
              </CardHeader>
              
              <div className="flex items-center gap-6 py-2">
                {/* SVG Circle Progress */}
                <div className="relative flex items-center justify-center shrink-0">
                  <svg className="w-26 h-26 transform -rotate-90">
                    {/* Background track */}
                    <circle
                      cx="52"
                      cy="52"
                      r={radius}
                      stroke="#f1f5f9"
                      strokeWidth="9"
                      fill="transparent"
                    />
                    {/* Animated color scale progress */}
                    <circle
                      cx="52"
                      cy="52"
                      r={radius}
                      stroke={scoreInfo.stroke}
                      strokeWidth="9"
                      fill="transparent"
                      strokeDasharray={circumference}
                      strokeDashoffset={strokeDashoffset}
                      strokeLinecap="round"
                      className="transition-all duration-1000 ease-out donut-segment"
                    />
                  </svg>
                  {/* Inside circle number */}
                  <div className="absolute flex flex-col items-center justify-center">
                    <span className="text-2xl font-semibold text-slate-900 leading-none">{safetyScore}</span>
                    <span className="text-[10px] text-slate-500 font-medium mt-0.5 tracking-wide">안전 점수</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs text-slate-600 font-medium">안전성 평가 등급</div>
                  <div className={`text-lg font-semibold ${scoreInfo.color} flex items-center gap-1.5`}>
                    {scoreInfo.label}
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed font-medium">
                    {safetyScore === 100
                      ? "검출된 계약 리스크가 없어 상대적으로 양호한 수준으로 보입니다."
                      : `고위험 요인을 포함하여 총 ${activeRisks.length}개의 리스크가 검출되었습니다.`
                    }
                  </p>
                </div>
              </div>
              
              <div className="pt-4 border-t border-slate-100 flex items-center justify-between text-xs font-semibold">
                <span className="text-slate-600">
                  권고안 반영률: <span className="text-navy-800 font-bold">{resolvedCount} / {contract.risks.length} 건</span>
                </span>
                {safetyScore < 100 && (
                  <button 
                    onClick={() => {
                      // Navigate directly to viewer with high risk selected
                      const firstActive = activeRisks[0] || contract.risks[0];
                      setSelectedRiskId(firstActive.id);
                      setActiveTab('viewer');
                    }}
                    className="text-navy-800 hover:text-navy-900 flex items-center gap-1 transition-colors group/btn cursor-pointer"
                  >
                    검토하기
                    <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover/btn:translate-x-0.5" />
                  </button>
                )}
              </div>
            </Card>

            {/* Severity Breakdown Stats Cards Container (7 Cols) */}
            <div className="lg:col-span-7 grid sm:grid-cols-3 gap-6 items-stretch">
              
              {/* High Risks Card */}
              <Card variant="dashboard" className="border-l-4 border-rose-500 flex flex-col justify-between p-6 shadow-sm transition-all duration-300">
                <CardHeader className="p-0">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-semibold text-rose-800 tracking-wide">
                      {koreanHeadings.highRisks}
                    </span>
                    <div className="w-8 h-8 rounded-lg bg-rose-50 border border-rose-100 flex items-center justify-center text-rose-500">
                      <ShieldAlert className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="text-4xl font-semibold text-rose-600 mt-3 tracking-tight">
                    {highRiskCount} <span className="text-xs text-slate-500 font-semibold">건</span>
                  </div>
                </CardHeader>
                <div className="text-[11px] text-slate-600 font-semibold pt-4 mt-2 border-t border-slate-100">
                  <Badge variant="high" className="px-2 py-0.5 text-[10px]">즉시 삭제 권고</Badge>
                </div>
              </Card>

              {/* Medium Risks Card */}
              <Card variant="dashboard" className="border-l-4 border-amber-500 flex flex-col justify-between p-6 shadow-sm transition-all duration-300">
                <CardHeader className="p-0">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-semibold text-amber-800 tracking-wide">
                      {koreanHeadings.mediumRisks}
                    </span>
                    <div className="w-8 h-8 rounded-lg bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-500">
                      <AlertTriangle className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="text-4xl font-semibold text-amber-600 mt-3 tracking-tight">
                    {mediumRiskCount} <span className="text-xs text-slate-500 font-semibold">건</span>
                  </div>
                </CardHeader>
                <div className="text-[11px] text-slate-600 font-semibold pt-4 mt-2 border-t border-slate-100">
                  <Badge variant="medium" className="px-2 py-0.5 text-[10px]">조건 조율 / 완화</Badge>
                </div>
              </Card>

              {/* Low Risks Card */}
              <Card variant="dashboard" className="border-l-4 border-emerald-500 flex flex-col justify-between p-6 shadow-sm transition-all duration-300">
                <CardHeader className="p-0">
                  <div className="flex justify-between items-center">
                    <span className="text-xs font-semibold text-emerald-800 tracking-wide">
                      {koreanHeadings.lowRisks}
                    </span>
                    <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-500">
                      <CheckCircle2 className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="text-4xl font-semibold text-emerald-600 mt-3 tracking-tight">
                    {lowRiskCount} <span className="text-xs text-slate-500 font-semibold">건</span>
                  </div>
                </CardHeader>
                <div className="text-[11px] text-slate-600 font-semibold pt-4 mt-2 border-t border-slate-100">
                  <Badge variant="low" className="px-2 py-0.5 text-[10px]">상대적 권고 / 경미</Badge>
                </div>
              </Card>

            </div>

          </div>

          {/* 분석 원문 미리보기 */}
          {apiScreening?.output_report && (
            <div className="pt-2">
              <Card variant="dashboard" className="p-5 border border-navy-100/80 bg-navy-50/30">
                <CardHeader className="p-0 mb-3">
                  <CardTitle className="text-sm font-bold text-slate-800 flex items-center gap-2">
                    <FileCheck className="w-4 h-4 text-navy-800" />
                    분석 원문 미리보기
                  </CardTitle>
                  <CardDescription className="text-xs">
                    법무 검토 보조를 위해 생성된 분석 원문 일부를 표시합니다.
                  </CardDescription>
                </CardHeader>
                <pre className="text-[11px] leading-relaxed p-4 rounded-xl bg-white border border-slate-200 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans text-slate-700">
                  {apiScreening.output_report.slice(0, 2000)}
                  {apiScreening.output_report.length > 2000 ? '…' : ''}
                </pre>
              </Card>
            </div>
          )}

          {/* Interactive Screen: Detailed interactive report summary table (Taking full 12 Cols) */}
          <div className="space-y-4 pt-2">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="text-slate-900 font-bold text-lg flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-navy-800" />
                검출 조항
              </div>
              
              {/* Search Bar Input */}
              <div className="relative max-w-xs w-full">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="조항명, 카테고리, 요약 내용 검색..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full text-xs pl-9 pr-4 py-2 bg-white border border-slate-200/90 rounded-lg focus:outline-none focus:ring-2 focus:ring-navy-800/10 focus:border-navy-800 transition-all duration-300 font-medium placeholder-slate-400 shadow-sm"
                />
              </div>
            </div>

            {/* Risky Clauses Table */}
            <div className="overflow-hidden bg-white border border-slate-200/90 rounded-2xl shadow-sm">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-2/5">검출 조항</TableHead>
                    <TableHead>위험 수준</TableHead>
                    <TableHead>분야</TableHead>
                    <TableHead className="text-right">상세 분석</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRisksList.map((risk) => {
                    const block = blocksByRiskId.get(risk.id);
                    const isResolved = block?.isResolved;

                    return (
                      <TableRow 
                        key={risk.id} 
                        className={`transition-all duration-300 cursor-pointer ${
                          isResolved 
                            ? 'bg-emerald-50/20 hover:bg-emerald-50/30' 
                            : selectedRiskId === risk.id 
                              ? 'bg-slate-50/90 font-medium' 
                              : 'hover:bg-slate-50/50'
                        }`}
                        onClick={() => {
                          setSelectedRiskId(risk.id);
                          setActiveTab('viewer');
                        }}
                      >
                        <TableCell className="font-semibold text-slate-900 py-3.5">
                          <div className="flex items-center gap-2.5">
                            {isResolved ? (
                              <div className="w-5 h-5 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 shrink-0">
                                <Check className="w-3.5 h-3.5" />
                              </div>
                            ) : (
                              <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                                risk.severity === 'high' ? 'bg-rose-50 border border-rose-100 text-rose-500' :
                                risk.severity === 'medium' ? 'bg-amber-50 border border-amber-100 text-amber-500' :
                                'bg-slate-50 border border-slate-200 text-slate-500'
                              }`}>
                                <AlertTriangle className="w-3 h-3" />
                              </div>
                            )}
                            <span>{risk.clauseName}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {isResolved ? (
                            <Badge variant="low">조치 완료</Badge>
                          ) : (
                            <Badge variant={risk.severity}>{
                              risk.severity === 'high' ? '고위험' :
                              risk.severity === 'medium' ? '중위험' : '저위험'
                            }</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-[11px] text-slate-600 font-semibold bg-slate-100 border border-slate-200/50 px-2.5 py-0.5 rounded-md">
                            {risk.category}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRiskId(risk.id);
                              setActiveTab('viewer');
                            }}
                            className="inline-flex items-center gap-1 text-xs font-bold text-navy-800 hover:text-navy-900 transition-colors group/act cursor-pointer"
                          >
                            {koreanHeadings.viewDetails}
                            <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover/act:translate-x-0.5" />
                          </button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {filteredRisksList.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-12 text-slate-600 font-medium">
                        검색 요건에 매칭되는 계약 조항 리스크 요인이 검출되지 않았습니다.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: HIGH-FIDELITY SCREENING VIEWER */}
      {activeTab === 'viewer' && (
        <div className="space-y-6 animate-fade-in-up">
          {contract.maskedText && (
            <MaskingCompare
              originalText={contract.fullText}
              maskedText={contract.maskedText}
            />
          )}
        <div className="grid lg:grid-cols-12 gap-8 items-start">
          
          {/* LEFT PANE: Premium Legal Document Reader Container */}
          <div className="lg:col-span-7 bg-white border border-slate-200/90 rounded-2xl shadow-sm overflow-hidden flex flex-col h-[740px]">
            {/* Pane Header */}
            <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/75 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-navy-50 flex items-center justify-center text-navy-800 border border-navy-100">
                  <FileText className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold text-slate-700 uppercase font-mono select-none">
                  {contract.title}
                  {jobId ? ` · ${jobId.slice(0, 8)}` : ''}
                </span>
              </div>
              <div className="text-[11px] text-slate-600 font-semibold flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                  고위험
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                  중위험
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  조치완료
                </span>
              </div>
            </div>

            {/* Document Body with absolute 32px (p-8) padding constraint & legalpad margins */}
            <div className="flex-1 overflow-y-auto p-8 legal-text font-sans text-slate-800 whitespace-pre-line leading-7 space-y-6 select-none bg-white relative">
              {blocks.map((block) => {
                if (!block.isRisk) {
                  return (
                    <div key={block.id} className="opacity-75 pl-10 pr-4 transition-all duration-300 text-slate-700 hover:opacity-100 leading-relaxed text-[15px]">
                      {block.text}
                    </div>
                  );
                }

                const risk = block.riskId ? risksById.get(block.riskId) : undefined;
                const isSelected = selectedRiskId === block.riskId;
                const isShining = shineBlockId === block.riskId;
                
                let highlightClass = "";
                let indicatorTag = "";
                
                if (block.isResolved) {
                  highlightClass = isSelected 
                    ? "bg-emerald-50/90 border-2 border-emerald-500 shadow-md text-emerald-950" 
                    : "bg-emerald-50/50 border border-emerald-300 text-emerald-900 opacity-90";
                  indicatorTag = "조치완료";
                } else if (risk?.severity === 'high') {
                  highlightClass = isSelected 
                    ? "bg-rose-50 border-2 border-rose-500 shadow-lg scale-[1.01] text-rose-950 font-medium" 
                    : "bg-rose-50/60 border border-rose-200 text-rose-900 hover:bg-rose-50/90 transition-all duration-200";
                  indicatorTag = "고위험";
                } else if (risk?.severity === 'medium') {
                  highlightClass = isSelected 
                    ? "bg-amber-50 border-2 border-amber-500 shadow-lg scale-[1.01] text-amber-950 font-medium" 
                    : "bg-amber-50/60 border border-amber-200 text-amber-900 hover:bg-amber-50/90 transition-all duration-200";
                  indicatorTag = "중위험";
                } else {
                  highlightClass = isSelected 
                    ? "bg-slate-100 border-2 border-slate-400 text-slate-900" 
                    : "bg-slate-50 border border-slate-200 text-slate-700";
                  indicatorTag = "저위험";
                }

                return (
                  <div
                    key={block.id}
                    onClick={() => risk && setSelectedRiskId(risk.id)}
                    className={`ml-10 p-4 rounded-xl cursor-pointer transition-all duration-300 relative select-none ${highlightClass} ${
                      isShining ? 'bg-emerald-100 border-emerald-600 text-emerald-950' : ''
                    }`}
                  >
                    {/* Visual left edge dynamic active highlighter */}
                    {isSelected && (
                      <span className="absolute -left-2 top-4 w-1.5 h-12 bg-navy-800 rounded-r-full shadow"></span>
                    )}
                    
                    {/* Corner Tag Label */}
                    <span className={`absolute right-3.5 top-3.5 text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full select-none ${
                      block.isResolved ? 'bg-emerald-500 text-white' :
                      risk?.severity === 'high' ? 'bg-rose-600 text-white' :
                      risk?.severity === 'medium' ? 'bg-amber-500 text-white' : 'bg-slate-500 text-white'
                    }`}>
                      {indicatorTag}
                    </span>

                    {/* Block Text content */}
                    <div className="pr-12 text-sm leading-7">
                      {block.text}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT PANE: Redlining Feed Panel */}
          <div className="lg:col-span-5 space-y-6">
            <Card variant="dashboard" className="border-l-4 border-l-navy-800 shadow-sm p-6 flex flex-col justify-between">
              
              <div className="space-y-5">
                <CardHeader className="pb-3 border-b border-slate-100 p-0 mb-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] bg-navy-800/10 text-navy-800 px-2.5 py-0.5 rounded-full font-medium tracking-wide border border-navy-800/10">
                      조항 분석
                    </span>
                    
                    {selectedBlock?.isResolved ? (
                      <Badge variant="low">조치 완료</Badge>
                    ) : (
                      selectedRisk && (
                        <Badge variant={selectedRisk.severity}>
                          {selectedRisk.severity === 'high' ? '고위험 조항' :
                           selectedRisk.severity === 'medium' ? '중위험 조항' : '저위험 조항'}
                        </Badge>
                      )
                    )}
                  </div>
                  
                  {selectedRisk && (
                    <CardTitle className="text-xl mt-3 font-bold text-slate-900 tracking-tight">
                      {selectedRisk.clauseName}
                    </CardTitle>
                  )}
                  {selectedRisk && (
                    <CardDescription className="text-xs text-slate-500 font-semibold mt-1 flex items-center gap-1.5">
                      <span>{selectedRisk.category}</span>
                      <span>•</span>
                      <span>조치 우선순위: <span className="font-bold text-slate-800">{selectedRisk.severity === 'high' ? '최우선' : selectedRisk.severity === 'medium' ? '권장' : '경미'}</span></span>
                    </CardDescription>
                  )}
                </CardHeader>

                {/* Risk Explanation */}
                <div className="space-y-1.5 p-3.5 bg-slate-50 border border-slate-200/60 rounded-xl">
                  <span className="text-[10px] font-semibold text-slate-500 tracking-wide">리스크 분석 요약</span>
                  <p className="text-xs font-bold text-slate-800 leading-relaxed">
                    {selectedRisk?.summary}
                  </p>
                </div>

                {/* Compare Clause Box with View Mode Slider Selector */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-700">비교 모드</span>
                    {/* Segmented control for diff views */}
                    <div className="inline-flex items-center p-0.5 bg-slate-100 rounded-lg border border-slate-200 shadow-inner">
                      <button
                        onClick={() => setDiffViewMode('side-by-side')}
                        className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-wider transition-all duration-300 cursor-pointer ${
                          diffViewMode === 'side-by-side' 
                            ? 'bg-white text-navy-800 shadow-sm border border-slate-200/50' 
                            : 'text-slate-500 hover:text-slate-900'
                        }`}
                      >
                        좌우 비교
                      </button>
                      <button
                        onClick={() => setDiffViewMode('redline')}
                        className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-wider transition-all duration-300 cursor-pointer ${
                          diffViewMode === 'redline' 
                            ? 'bg-white text-navy-800 shadow-sm border border-slate-200/50' 
                            : 'text-slate-500 hover:text-slate-900'
                        }`}
                      >
                        레드라인 비교
                      </button>
                    </div>
                  </div>

                  {diffViewMode === 'side-by-side' ? (
                    <div className="space-y-3.5 animate-slide-in">
                      {/* Original text block */}
                      <div className="space-y-1">
                        <span className="text-[10px] font-semibold text-rose-700 tracking-wide flex items-center gap-1">
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                          {koreanHeadings.originalClause}
                        </span>
                        <div className="p-3 bg-rose-50/30 border border-rose-200/60 rounded-xl text-xs font-sans text-slate-700 leading-6 max-h-32 overflow-y-auto">
                          {selectedBlock?.originalText}
                        </div>
                      </div>

                      {/* Recommendation block */}
                      {selectedRisk && (
                        <div className="space-y-1">
                          <span className="text-[10px] font-semibold text-navy-800 tracking-wide flex items-center gap-1">
                            <Sparkles className="w-3.5 h-3.5 text-navy-800 shrink-0" />
                            {koreanHeadings.suggestedClause}
                          </span>
                          <div className="p-3 bg-navy-50/30 border border-navy-200/60 rounded-xl text-xs font-sans text-navy-950 leading-6 max-h-32 overflow-y-auto font-medium">
                            {selectedRisk.recommendation}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1.5 animate-slide-in">
                      <span className="text-[10px] font-semibold text-navy-800 tracking-wide flex items-center gap-1 select-none">
                        <Sparkles className="w-3.5 h-3.5 text-navy-800 shrink-0" />
                        수정 권고 레드라인 (단어 비교)
                      </span>
                      {selectedRisk && selectedBlock && renderWordDiff(selectedDiffParts)}
                    </div>
                  )}
                </div>

                {/* Direct Action Trigger CTAs */}
                <div className="pt-2 flex gap-2.5">
                  {selectedBlock?.isResolved ? (
                    <button
                      onClick={() => selectedRisk && handleRevertClause(selectedRisk.id)}
                      className="w-full bg-slate-100 hover:bg-slate-200 text-slate-900 text-xs font-bold py-2.5 px-4 rounded-xl transition-all duration-300 flex items-center justify-center gap-1.5 border border-slate-200 shadow-sm cursor-pointer active:scale-98"
                    >
                      <Undo className="w-3.5 h-3.5" />
                      원본 조항으로 복원
                    </button>
                  ) : (
                    selectedRisk && (
                      <button
                        onClick={() => handleApplyRecommendation(selectedRisk.id, selectedRisk.recommendation)}
                        className="w-full bg-navy-800 hover:bg-navy-900 text-white text-xs font-semibold py-2.5 px-4 rounded-xl shadow-sm transition-all duration-300 hover:shadow flex items-center justify-center gap-1.5 cursor-pointer active:scale-98"
                      >
                        <FileCheck className="w-3.5 h-3.5" />
                        수정 권고안 본문 반영
                      </button>
                    )
                  )}
                  
                  <button
                    onClick={() => {
                      if (selectedRisk) {
                        navigator.clipboard.writeText(selectedRisk.recommendation);
                        alert("추천 권고 수정문구가 클립보드에 성공적으로 복사되었습니다.");
                      }
                    }}
                    className="p-2.5 bg-white border border-slate-200 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors shrink-0 shadow-sm cursor-pointer"
                    title="권고안 복사"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>

                {/* Detailed Analysis Accordion */}
                {selectedRisk && (
                  <div className="pt-3.5 border-t border-slate-100">
                    <Accordion>
                      <AccordionItem id="detail-analysis" trigger={koreanHeadings.analysisDetail}>
                        <div className="space-y-3.5 pt-1">
                          <p className="text-sm leading-6 text-slate-600 font-medium select-text">{selectedRisk.analysisDetail}</p>
                          <div className="flex justify-between items-center bg-slate-50 border border-slate-200/50 p-3 rounded-xl text-xs">
                            <span className="font-bold text-slate-500">조치 난이도 및 비용:</span>
                            <Badge variant={
                              selectedRisk.remedyCost === 'High' ? 'high' :
                              selectedRisk.remedyCost === 'Medium' ? 'medium' : 'low'
                            }>
                              {selectedRisk.remedyCost === 'High' ? '난이도 상' :
                               selectedRisk.remedyCost === 'Medium' ? '난이도 중' : '난이도 하'}
                            </Badge>
                          </div>
                        </div>
                      </AccordionItem>
                    </Accordion>
                  </div>
                )}
              </div>

              {/* Return link */}
              <button
                onClick={() => setActiveTab('overview')}
                className="text-xs font-bold text-slate-500 hover:text-slate-800 flex items-center gap-1 transition-colors pl-1 pt-6 cursor-pointer"
              >
                ← 분석 요약으로 돌아가기
              </button>

            </Card>
          </div>
        </div>
        </div>
      )}
    </div>
  );
};
