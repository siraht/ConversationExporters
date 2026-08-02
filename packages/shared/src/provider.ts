export interface ProviderDescriptor<ProviderId extends string = string> {
  id: ProviderId;
  archiveSchemaVersion: number;
  displayName: string;
  primaryOrigin: string;
  manifestHosts: readonly string[];
  conversationUrl(conversationId: string): string;
}

export interface ProviderInventoryPage<Scope, Cursor, Entry, RawPage> {
  scope: Scope;
  requestedCursor: Cursor | null;
  nextCursor: Cursor | null;
  entries: readonly Entry[];
  raw: RawPage;
  terminal: boolean;
}

export interface ProviderValidationResult<Finding> {
  valid: boolean;
  findings: readonly Finding[];
}

/**
 * Capability contract for orchestration code. Each provider owns the concrete
 * account, cursor, raw-envelope, normalized, asset, and validation types so
 * token, offset, and cursor pagination never leak into the shared core.
 */
export interface ExporterProvider<
  ProviderId extends string,
  Context,
  Account,
  Scope,
  Cursor,
  InventoryEntry,
  RawInventoryPage,
  RawConversation,
  SupportingMetadata,
  NormalizedConversation,
  AssetDescriptor,
  Finding,
> {
  descriptor: ProviderDescriptor<ProviderId>;
  preflight(context: Context): Promise<void>;
  accounts(context: Context): Promise<readonly Account[]>;
  inventoryPages(
    context: Context,
    account: Account,
    scopes: readonly Scope[],
  ): AsyncIterable<ProviderInventoryPage<Scope, Cursor, InventoryEntry, RawInventoryPage>>;
  captureConversation(context: Context, account: Account, entry: InventoryEntry): Promise<RawConversation>;
  captureSupportingMetadata(context: Context, account: Account): Promise<SupportingMetadata>;
  normalize(raw: RawConversation, entry: InventoryEntry): Promise<NormalizedConversation>;
  discoverAssets(raw: RawConversation, normalized: NormalizedConversation): readonly AssetDescriptor[];
  sourceUrls(entry: InventoryEntry, asset: AssetDescriptor | null): readonly string[];
  validate(raw: RawConversation, normalized: NormalizedConversation): Promise<ProviderValidationResult<Finding>>;
}
