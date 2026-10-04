import {
  type ExecApi,
  type PrLookupResult,
  type ProviderConfig,
  type PrRefReference,
  type PrSummary,
  type PrUrlReference,
  type RepoContext,
} from "../types.js";

export interface ProviderAdapter {
  getPrByBranch(
    pi: ExecApi,
    repo: RepoContext,
    provider: ProviderConfig,
    branch: string
  ): Promise<PrLookupResult>;
  getPrByRef(
    pi: ExecApi,
    repo: RepoContext,
    provider: ProviderConfig,
    reference: PrRefReference
  ): Promise<PrLookupResult>;
  getPrByUrl(
    pi: ExecApi,
    provider: ProviderConfig,
    reference: PrUrlReference
  ): Promise<PrLookupResult>;
  listRepoActivePrs(
    pi: ExecApi,
    repo: RepoContext,
    provider: ProviderConfig
  ): Promise<PrSummary[] | PrLookupResult>;
}
