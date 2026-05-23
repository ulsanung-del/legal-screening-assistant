import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  getJobStatus,
  getResult,
  runScreen,
  uploadContract,
  isAbortRequestError,
  isTimeoutRequestError,
  LOCAL_DEMO_MODE,
  type JobStatus,
  type ScreeningResult,
  type UploadResponse,
} from '../api/client';
import type { UploadMeta } from '../lib/mapScreeningResult';

export const screeningKeys = {
  all: ['screening'] as const,
  status: (jobId: string) => ['screening', 'status', jobId] as const,
  result: (jobId: string) => ['screening', 'result', jobId] as const,
};

export async function clearScreeningQueries(
  queryClient: QueryClient,
  jobId?: string | null,
): Promise<void> {
  if (jobId) {
    await queryClient.cancelQueries({ queryKey: screeningKeys.status(jobId), exact: true });
    await queryClient.cancelQueries({ queryKey: screeningKeys.result(jobId), exact: true });
    queryClient.removeQueries({ queryKey: screeningKeys.status(jobId), exact: true });
    queryClient.removeQueries({ queryKey: screeningKeys.result(jobId), exact: true });
    return;
  }
  await queryClient.cancelQueries({ queryKey: screeningKeys.all });
  queryClient.removeQueries({ queryKey: screeningKeys.all });
}

export interface StartScreeningResult {
  upload: UploadResponse;
  uploadMeta: UploadMeta;
  status: JobStatus;
  requestId: number;
}

export function useStartScreening() {
  const queryClient = useQueryClient();
  const startAbortRef = useRef<AbortController | null>(null);
  const isUnmountedRef = useRef(false);
  const requestSeqRef = useRef(0);
  const activeRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      isUnmountedRef.current = true;
      activeRequestIdRef.current = null;
      startAbortRef.current?.abort();
    };
  }, []);

  const cancelStartRequest = useCallback(() => {
    startAbortRef.current?.abort();
  }, []);

  const mutation = useMutation({
    mutationFn: async (file: File) => {
      const requestId = requestSeqRef.current + 1;
      requestSeqRef.current = requestId;
      activeRequestIdRef.current = requestId;
      startAbortRef.current?.abort();
      const controller = new AbortController();
      startAbortRef.current = controller;
      try {
        const upload = await uploadContract(file, { signal: controller.signal });
        const status = await runScreen(upload.job_id, { signal: controller.signal });
        return {
          upload,
          uploadMeta: {
            filename: upload.filename,
            file_type: upload.file_type,
            text_preview: upload.text_preview,
            char_count: upload.char_count,
          },
          status,
          requestId,
        };
      } finally {
        if (startAbortRef.current === controller) {
          startAbortRef.current = null;
        }
      }
    },
    onSuccess: (data: StartScreeningResult) => {
      if (isUnmountedRef.current) return;
      if (activeRequestIdRef.current !== data.requestId) return;
      queryClient.setQueryData<JobStatus>(screeningKeys.status(data.upload.job_id), data.status);
      queryClient.removeQueries({ queryKey: screeningKeys.result(data.upload.job_id) });
      if (LOCAL_DEMO_MODE && data.status.status === 'completed') {
        void queryClient.fetchQuery({
          queryKey: screeningKeys.result(data.upload.job_id),
          queryFn: ({ signal }) => getResult(data.upload.job_id, { signal }),
          staleTime: Infinity,
        });
      }
    },
    onError: (error) => {
      if (isAbortRequestError(error)) return;
      activeRequestIdRef.current = null;
    },
  });

  return {
    ...mutation,
    cancelStartRequest,
  };
}

export function useJobStatus(jobId: string | null) {
  return useQuery<JobStatus>({
    queryKey: screeningKeys.status(jobId ?? ''),
    queryFn: ({ signal }) => getJobStatus(jobId!, { signal }),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'completed' || status === 'failed') return false;
      return LOCAL_DEMO_MODE ? 250 : 1250;
    },
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => {
      if (isAbortRequestError(error)) return false;
      if (isTimeoutRequestError(error)) return failureCount < 2;
      return failureCount < 2;
    },
    retryDelay: LOCAL_DEMO_MODE ? 100 : 500,
  });
}

export function useScreeningResult(jobId: string | null, status?: JobStatus['status']) {
  return useQuery<ScreeningResult>({
    queryKey: screeningKeys.result(jobId ?? ''),
    queryFn: ({ signal }) => getResult(jobId!, { signal }),
    enabled: Boolean(jobId) && status === 'completed',
    staleTime: Infinity,
    retry: (failureCount, error) => {
      if (isAbortRequestError(error)) return false;
      if (isTimeoutRequestError(error)) return failureCount < 2;
      return failureCount < 1;
    },
    retryDelay: LOCAL_DEMO_MODE ? 100 : 700,
  });
}
