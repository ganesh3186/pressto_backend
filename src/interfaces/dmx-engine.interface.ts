/**
 * DMX Engine v1.0.0 TypeScript Interfaces
 * pressto Extraction Engine Integration
 */

export interface DMXExtractionRequest {
  targetUrl: string;
  description: string;
  useCase: string;
  smartFetch?: boolean;
  useJavaScript?: boolean;
}

export interface DMXGeneratedSelector {
  field: string;
  css: string;
  confidence: number;
  reasoning: string;
  matchCount?: number;
  preview?: string | null;
}

export interface DMXSampleData {
  field: string;
  selector: string;
  text: string;
  html: string;
  attributes: Record<string, any>;
  match_index: number;
}

export interface DMXAnalysisMetadata {
  aiModel: string;
  processingTime: number;
  htmlSize: number;
  selectorsGenerated: number;
  timestamp: string;
}

export interface DMXFetcherInfo {
  fetcher_used: 'simple' | 'playwright';
  fallback_used: boolean;
  reason: string;
  dmx_strategy?: string;
}

export interface DMXEngineInfo {
  name: string;
  code: string;
  version: string;
  build: string;
  author: string;
  license: string;
  current_features: string[];
  supported_sites: string[];
}

export interface DMXExtractionResponse {
  success: boolean;
  selectors: DMXGeneratedSelector[];
  sampleData: DMXSampleData[];
  metadata: DMXAnalysisMetadata;
  fetcherInfo?: DMXFetcherInfo;
  dmxEngine?: DMXEngineInfo;
  error?: string | null;
}

export interface DMXEngineStatus {
  engine: DMXEngineInfo;
  status: string;
  capabilities: {
    ai_powered_selectors: boolean;
    anti_detection: boolean;
    multi_site_support: boolean;
    hybrid_fetching: boolean;
    smart_analysis: boolean;
    confidence_scoring: boolean;
  };
  supported_operations: string[];
}

export interface DMXExtractionJob {
  id?: string;
  userId?: string;
  request: DMXExtractionRequest;
  response?: DMXExtractionResponse;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt?: Date;
  updatedAt?: Date;
  processingTime?: number;
  errorMessage?: string;
}

export interface DMXEngineConfig {
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
}