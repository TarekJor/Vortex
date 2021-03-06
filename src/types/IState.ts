import { IAttributeState } from './IAttributeState';
import { IDialog } from './IDialog';
import { INotification } from './INotification';

import { ICategoryDictionary } from '../extensions/category_management/types/ICategoryDictionary';
import { IDownload } from '../extensions/download_management/types/IDownload';
import { IDiscoveryResult } from '../extensions/gamemode_management/types/IDiscoveryResult';
import { IGameStored } from '../extensions/gamemode_management/types/IGameStored';
import { IMod } from '../extensions/mod_management/types/IMod';
import { IProfile } from '../extensions/profile_management/types/IProfile';

// re-export these to keep the imports from extensions local
export { IDownload, IDiscoveryResult, IGameStored, IMod, IProfile };

/**
 * interface to represent a position on the screen
 *
 * @export
 * @interface IPosition
 */
export interface IPosition {
  x: number;
  y: number;
}

/**
 * interface to represent pixel-dimensions on the screen
 *
 * @export
 * @interface IDimensions
 */
export interface IDimensions {
  height: number;
  width: number;
}

/**
 * interface for window state
 *
 * @export
 * @interface IWindow
 */
export interface IWindow {
  maximized: boolean;
  position?: IPosition;
  size: IDimensions;
  tabsMinimized: boolean;
  customTitlebar: boolean;
}

/**
 * state regarding all manner of user interaction
 *
 * @export
 * @interface INotificationState
 */
export interface INotificationState {
  notifications: INotification[];
  dialogs: IDialog[];
}

export interface IExtensionLoadFailure {
  id: string;
  args: { [key: string]: any };
}

export interface IProgress {
  text: string;
  percent: number;
}

/**
 * "ephemeral" session state.
 * This state is generated at startup and forgotten at application exit
 *
 * @export
 * @interface ISession
 */
export interface ISession {
  displayGroups: { [id: string]: string };
  overlayOpen: boolean;
  visibleDialog: string;
  mainPage: string;
  secondaryPage: string;
  activity: { [id: string]: string };
  progress: { [group: string]: { [id: string]: IProgress } };
  settingsPage: string;
  extLoadFailures: { [extId: string]: IExtensionLoadFailure[] };
}

export interface IRowState {
  selected: boolean;
  highlighted: boolean;
}

export interface ITableState {
  attributes: { [id: string]: IAttributeState };
  rows: { [id: string]: IRowState };
}

export interface IExtensionState {
  enabled: boolean | 'failed';
  remove: boolean;
}

/**
 * settings relating to the vortex application itself
 */
export interface IApp {
  instanceId: string;
  version: string;
  extensions: { [id: string]: IExtensionState };
}

/**
 * settings relating to the user (os account) personally
 * even in a multi-user environment
 *
 * @export
 * @interface IUser
 */
export interface IUser {
  multiUser: boolean;
}

export interface ITableStates {
  [id: string]: ITableState;
}

export interface IStateDownloads {
  speed: number;
  speedHistory: number[];
  files: { [id: string]: IDownload };
}

export interface IDashletSettings {
  enabled: boolean;
}

export interface ISettingsInterface {
  language: string;
  advanced: boolean;
  profilesVisible: boolean;
  dashboardLayout: string[];
  dashletSettings: { [dashletId: string]: IDashletSettings };
}

export interface ISettingsProfiles {
  activeProfileId: string;
  nextProfileId: string;
  lastActiveProfile: { [gameId: string]: string };
}

export interface ISettingsGameMode {
  discovered: { [id: string]: IDiscoveryResult };
  searchPaths: string[];
  pickerLayout: 'list' | 'small' | 'large';
}

export interface ISettingsDownloads {
    minChunkSize: number;
    maxChunks: number;
    maxParallelDownloads: number;
}

export interface IStatePaths {
  base: string;
  download: string;
  install: string;
}

export interface ISettingsMods {
  paths: { [gameId: string]: IStatePaths };
  modlistState: { [id: string]: IAttributeState };
  activator: { [gameId: string]: string };
}

export interface ISettingsUpdate {
  channel: 'stable' | 'beta' | 'none';
}

export interface ISettings {
  interface: ISettingsInterface;
  gameMode: ISettingsGameMode;
  profiles: ISettingsProfiles;
  window: IWindow;
  downloads: ISettingsDownloads;
  mods: ISettingsMods;
  tables: ITableStates;
  update: ISettingsUpdate;
}

export interface ISessionGameMode {
  known: IGameStored[];
  addDialogVisible: boolean;
}

export interface IGameInfoEntry {
  provider: string;
  expires: number;
  title: string;
  value: any;
  type?: string;
}

export interface IStateGameMode {
  gameInfo: {
    [gameId: string]: {
      [key: string]: IGameInfoEntry,
    },
  };
}

export interface IBrowserState {
  url: string;
}

export interface IModTable {
  [gameId: string]: {
    [modId: string]: IMod;
  };
}

/**
 * interface for the top-level state object
 * this should precisely mirror the reducer structure
 *
 * @export
 * @interface IState
 */
export interface IState {
  app: IApp;
  user: IUser;
  confidential: {
    account: { },
  };
  session: {
    base: ISession,
    gameMode: ISessionGameMode,
    discovery: IDiscoveryState,
    notifications: INotificationState;
    browser: IBrowserState;
  };
  settings: ISettings;
  persistent: {
    profiles: { [profileId: string]: IProfile },
    mods: IModTable,
    downloads: IStateDownloads,
    categories: { [gameId: string]: ICategoryDictionary },
    gameMode: IStateGameMode,
  };
}

export interface IDiscoveryPhase {
  progress: number;
  directory: string;
}

/**
 * state of the (lengthy) gamemode discovery
 *
 * @export
 * @interface IDiscoveryState
 */
export interface IDiscoveryState {
  running: boolean;
  phases: { [id: number]: IDiscoveryPhase };
}

/**
 * gamemode-related application settings
 *
 * @export
 * @interface ISettings
 */
export interface IGameModeSettings {
}
