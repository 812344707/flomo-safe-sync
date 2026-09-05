import { DEFAULT_NOTE_TEMPLATE, ExcludedPolicy, TagFolderMapping, UpdateMode, createNoteTemplateFromYaml, normalizeTagList } from './sync-core';

/** Recommended Unicode-style date fields for new installations. */
export const DEFAULT_FILE_NAME = '{{yyyy-MM-dd}}_{{HH-mm-ss}}_{{title:20}}_{{slug:8}}';
/** Previous default retained so existing installations keep identical filenames. */
export const LEGACY_DEFAULT_FILE_NAME = '{{date}}_{{time}}_{{title:20}}_{{slug:8}}';
export const CURRENT_SETTINGS_VERSION = 6;
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
  /** Original Flomo asset URL -> current local path or image-host URL. */
  assetMap?: Record<string, string>;
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
  /** The default-mode template saved for this installation. */
  defaultFileNameTemplate: string;
  customFileNameTemplate: string;
  fileNameTemplate: string;
  noteTemplate: string;
  /** Kept for lossless migration from the v0.3.1 YAML-only editor. */
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
  fileNameMode: 'default', defaultFileNameTemplate: DEFAULT_FILE_NAME,
  fileNameTemplate: DEFAULT_FILE_NAME, customFileNameTemplate: DEFAULT_FILE_NAME,
  noteTemplate: DEFAULT_NOTE_TEMPLATE, yamlTemplate: '', scopeMode: 'include', scopeTags: [], tagFolderMappings: [], availableFlomoTags: [],
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

  // No persisted data means a genuinely new installation, which starts with
  // the current recommended date pattern rather than a compatibility default.
  if (Object.keys(loaded).length === 0) return settings;

  // A current or newer schema is never normalized or rewritten during load.
  // Object spread above only supplies settings introduced after it was saved.
  if (sourceVersion >= CURRENT_SETTINGS_VERSION) {
    settings.settingsVersion = sourceVersion;
    return settings;
  }

  // v3-v5 -> v6 keeps the exact active filename template. Default mode now has
  // its own saved template so legacy installs do not silently change filenames.
  if (sourceVersion >= 3) {
    settings.defaultFileNameTemplate = loaded.defaultFileNameTemplate
      || (loaded.fileNameMode === 'default' ? loaded.fileNameTemplate : '')
      || LEGACY_DEFAULT_FILE_NAME;
    settings.noteTemplate = loaded.noteTemplate || createNoteTemplateFromYaml(loaded.yamlTemplate || '');
    settings.settingsVersion = CURRENT_SETTINGS_VERSION;
    return settings;
  }

  // v0.1/v0.2 -> current: copy every old value, then derive only fields that did
  // not exist in the older schema.
  settings.rootFolder = loaded.rootFolder || loaded.flomoFolder || DEFAULT_SETTINGS.rootFolder;
  settings.tagFolderMappings = (loaded.tagFolderMappings || []).map(m => ({ tag: normalizeTagList([m.tag])[0] || '', folder: m.folder })).filter(m => m.tag);
  settings.scopeMode = loaded.scopeMode === 'exclude' ? 'exclude' : 'include';
  settings.scopeTags = normalizeTagList(loaded.scopeTags ?? settings.tagFolderMappings.map(m => m.tag));
  settings.availableFlomoTags = normalizeTagList(loaded.availableFlomoTags || []);
  settings.excludedTags = normalizeTagList(loaded.excludedTags || []);
  settings.excludedPolicy = loaded.excludedPolicy === 'skip' ? 'skip' : 'freeze';
  const oldTemplate = loaded.fileNameTemplate || LEGACY_DEFAULT_FILE_NAME;
  settings.fileNameMode = loaded.fileNameMode
    || ([DEFAULT_FILE_NAME, LEGACY_DEFAULT_FILE_NAME].includes(oldTemplate) ? 'default' : 'custom');
  settings.defaultFileNameTemplate = settings.fileNameMode === 'default' ? oldTemplate : LEGACY_DEFAULT_FILE_NAME;
  settings.customFileNameTemplate = loaded.customFileNameTemplate || oldTemplate;
  settings.fileNameTemplate = settings.fileNameMode === 'default' ? settings.defaultFileNameTemplate : settings.customFileNameTemplate;
  settings.noteTemplate = loaded.noteTemplate || createNoteTemplateFromYaml(loaded.yamlTemplate || '');
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
