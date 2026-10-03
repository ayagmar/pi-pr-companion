import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type PrLookupResult,
  type ProviderConfig,
  type PrRefReference,
  type PrSummary,
  type PrUrlReference,
  type RepoContext,
} from "../types.js";

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
