import type {
  PrLookupResult,
  PrRefReference,
  PrSummary,
  PrUrlReference,
  ProviderConfig,
  RepoContext,
} from "../types.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface ProviderAdapter {
  getPrByBranch(
    pi: ExtensionAPI,
    repo: RepoContext,
    provider: ProviderConfig,
    branch: string
  ): Promise<PrLookupResult>;
  getPrByRef(
    pi: ExtensionAPI,
    repo: RepoContext,
    provider: ProviderConfig,
    reference: PrRefReference
  ): Promise<PrLookupResult>;
  getPrByUrl(
    pi: ExtensionAPI,
    provider: ProviderConfig,
    reference: PrUrlReference
  ): Promise<PrLookupResult>;
  listRepoActivePrs(
    pi: ExtensionAPI,
    repo: RepoContext,
    provider: ProviderConfig
  ): Promise<PrSummary[] | PrLookupResult>;
}
