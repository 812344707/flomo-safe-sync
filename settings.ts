import { ExcludedPolicy, TagFolderMapping, UpdateMode, normalizeTagList } from './sync-core';

export const DEFAULT_FILE_NAME = '{{date}}_{{time}}_{{title:20}}_{{slug:8}}';
export const CURRENT_SETTINGS_VERSION = 3;
export type DeletionAction = 'keep' | 'mark' | 'archive' | 'trash';
export interface FileState {
  path: string;
  originalPath?: string;
  state: 'live' | 'archived' | 'trashed';
  pending?: { action: 'archive' | 'restore' | 'trash'; target?: string };
}
export interface SyncedMemoRecord {
  updated_at: string;
  fileName: string;
  filePaths: string[];
  status?: 'active' | 'deleted';
  excluded?: boolean;
  outOfScope?: boolean;
  lastKnownTags?: string[];
  lastAppliedFlomoTags?: string[];
  tagsMerged?: boolean;
  assetFolder?: string;
  deletedDetectedAt?: string;
  bodyUpdatedAt?: string;
  propertiesUpdatedAt?: string;
  pendingTrash?: boolean;
  fileStates?: FileState[];
}
export interface FlomoSafeSyncSettings {
  settingsVersion: number;
  bearerToken: string;
  rootFolder: string;
  fileNameMode: 'default' | 'custom';
  customFileNameTemplate: string;
  fileNameTemplate: string;
  yamlTemplate: string;
  scopeMode: 'include' | 'exclude';
  scopeTags: string[];
  tagFolderMappings: TagFolderMapping[];
  availableFlomoTags: string[];
  excludedTags: string[];
  excludedPolicy: ExcludedPolicy;
  imageFolder: string;
  localizeImages: boolean;
  updateMode: UpdateMode;
  deletionAction: DeletionAction;
  archiveFolder: string;
  autoSyncOnStartup: boolean;
  autoSyncIntervalMinutes: number;
  lastSyncTime: number;
  syncedMemos: Record<string, SyncedMemoRecord>;
}
export const DEFAULT_SETTINGS: FlomoSafeSyncSettings = {
  settingsVersion: CURRENT_SETTINGS_VERSION, bearerToken: '', rootFolder: '00-Flomo收件箱',
  fileNameMode: 'default', fileNameTemplate: DEFAULT_FILE_NAME, customFileNameTemplate: DEFAULT_FILE_NAME,
  yamlTemplate: '', scopeMode: 'include', scopeTags: [], tagFolderMappings: [], availableFlomoTags: [],
  excludedTags: [], excludedPolicy: 'freeze', imageFolder: '00-Flomo收件箱/_attachments/flomo',
  localizeImages: true, updateMode: 'both', deletionAction: 'mark', archiveFolder: 'Flomo归档',
  autoSyncOnStartup: false, autoSyncIntervalMinutes: 60, lastSyncTime: 0, syncedMemos: {},
};

/**
 * Upgrade policy: saved v3 settings are the source of truth. New defaults only
 * fill missing keys; versioned migrations may transform older schemas after a
 * deep copy. Unknown keys survive so a newer plugin is not damaged by loading.
 */
export function migrateSettings(input: Partial<FlomoSafeSyncSettings> & { flomoFolder?: string } = {}): FlomoSafeSyncSettings {
  const loaded = JSON.parse(JSON.stringify(input || {})) as typeof input;
  const settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...loaded } as FlomoSafeSyncSettings;
  const sourceVersion = typeof loaded.settingsVersion === 'number' ? loaded.settingsVersion : 0;

  // A current or newer schema is never normalized or rewritten during load.
  // Object spread above only supplies settings introduced after it was saved.
  if (sourceVersion >= CURRENT_SETTINGS_VERSION) {
    settings.settingsVersion = sourceVersion;
    return settings;
  }

  // v0.1/v0.2 -> v0.3: copy every old value, then derive only fields that did
  // not exist in the older schema.
  settings.rootFolder = loaded.rootFolder || loaded.flomoFolder || DEFAULT_SETTINGS.rootFolder;
  settings.tagFolderMappings = (loaded.tagFolderMappings || []).map(m => ({ tag: normalizeTagList([m.tag])[0] || '', folder: m.folder })).filter(m => m.tag);
  settings.scopeMode = loaded.scopeMode === 'exclude' ? 'exclude' : 'include';
  settings.scopeTags = normalizeTagList(loaded.scopeTags ?? settings.tagFolderMappings.map(m => m.tag));
  settings.availableFlomoTags = normalizeTagList(loaded.availableFlomoTags || []);
  settings.excludedTags = normalizeTagList(loaded.excludedTags || []);
  settings.excludedPolicy = loaded.excludedPolicy === 'skip' ? 'skip' : 'freeze';
  const oldTemplate = loaded.fileNameTemplate || DEFAULT_FILE_NAME;
  settings.fileNameMode = loaded.fileNameMode || (oldTemplate === DEFAULT_FILE_NAME ? 'default' : 'custom');
  settings.customFileNameTemplate = loaded.customFileNameTemplate || oldTemplate;
  settings.fileNameTemplate = settings.fileNameMode === 'default' ? DEFAULT_FILE_NAME : settings.customFileNameTemplate;
  settings.imageFolder = loaded.imageFolder || `${settings.rootFolder}/_attachments/flomo`;
  settings.updateMode = ['both', 'body', 'properties', 'new-only'].includes(loaded.updateMode || '') ? loaded.updateMode! : 'both';
  settings.deletionAction = ['keep', 'mark', 'archive', 'trash'].includes(loaded.deletionAction || '') ? loaded.deletionAction! : 'mark';
  settings.syncedMemos = loaded.syncedMemos || {};
  for (const record of Object.values(settings.syncedMemos)) {
    record.status = record.status || 'active';
    record.filePaths = record.filePaths || [];
    record.lastKnownTags = normalizeTagList(record.lastKnownTags || []);
    if (record.lastAppliedFlomoTags) record.lastAppliedFlomoTags = normalizeTagList(record.lastAppliedFlomoTags);
    // A v0.2 record's updated_at represents both successfully applied regions.
    record.bodyUpdatedAt = record.updated_at;
    record.propertiesUpdatedAt = record.tagsMerged ? record.updated_at : undefined;
  }
  settings.settingsVersion = CURRENT_SETTINGS_VERSION;
  return settings;
}
