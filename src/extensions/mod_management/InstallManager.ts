import { showDialog } from '../../actions/notifications';
import { IDialogResult } from '../../types/IDialog';
import { IExtensionApi } from '../../types/IExtensionContext';
import {IState} from '../../types/IState';
import { ProcessCanceled, UserCanceled } from '../../util/CustomErrors';
import { createErrorReport } from '../../util/errorHandling';
import * as fs from '../../util/fs';
import getNormalizeFunc, { Normalize } from '../../util/getNormalizeFunc';
import { log } from '../../util/log';
import { activeGameId, activeProfile, downloadPath, gameName } from '../../util/selectors';
import { getSafe } from '../../util/storeHelper';
import { setdefault } from '../../util/util';
import walk from '../../util/walk';

import { IDownload } from '../download_management/types/IDownload';
import { getGame } from '../gamemode_management';
import { IModType } from '../gamemode_management/types/IModType';
import modName from '../mod_management/util/modName';
import { setModEnabled } from '../profile_management/actions/profiles';

import {setModAttribute, setModType} from './actions/mods';
import {IDependency} from './types/IDependency';
import { IInstallResult, IInstruction } from './types/IInstallResult';
import {IMod} from './types/IMod';
import { IModInstaller } from './types/IModInstaller';
import { InstallFunc } from './types/InstallFunc';
import { ISupportedResult, TestSupported } from './types/TestSupported';
import gatherDependencies from './util/dependencies';
import filterModInfo from './util/filterModInfo';

import InstallContext from './InstallContext';
import deriveModInstallName from './modIdManager';

import * as Promise from 'bluebird';
import * as I18next from 'i18next';
import { IHashResult, ILookupResult, IReference, IRule } from 'modmeta-db';
import ZipT = require('node-7z');
import * as os from 'os';
import * as path from 'path';
import * as Redux from 'redux';
import * as rimraf from 'rimraf';

export class ArchiveBrokenError extends Error {
  constructor() {
    super('ArchiveBroken');

    this.name = this.constructor.name;
  }
}

// TODO: the type declaration for rimraf is actually wrong atm (v0.0.28)
interface IRimrafOptions {
  glob?: { nosort: boolean, silent: boolean } | false;
  disableGlob?: boolean;
  emfileWait?: number;
  maxBusyTries?: number;
}
type rimrafType = (path: string, options: IRimrafOptions, callback: (err?) => void) => void;
const rimrafAsync: (path: string, options: IRimrafOptions) => Promise<void> =
  Promise.promisify(rimraf as rimrafType) as any;

interface IZipEntry {
  date: Date;
  attr: string;
  size: number;
  name: string;
}

interface ISupportedInstaller {
  installer: IModInstaller;
  requiredFiles: string[];
}

class InstructionGroups {
  public copy: IInstruction[] = [];
  public mkdir: IInstruction[] = [];
  public submodule: IInstruction[] = [];
  public generatefile: IInstruction[] = [];
  public iniedit: IInstruction[] = [];
  public unsupported: IInstruction[] = [];
  public attribute: IInstruction[] = [];
  public setmodtype: IInstruction[] = [];
  public error: IInstruction[] = [];
}

export const INI_TWEAKS_PATH = 'Ini Tweaks';

/**
 * central class for the installation process
 *
 * @class InstallManager
 */
class InstallManager {
  private mInstallers: IModInstaller[] = [];
  private mGetInstallPath: (gameId: string) => string;
  private mTask: ZipT;
  private mQueue: Promise<void>;

  constructor(installPath: (gameId: string) => string) {
    this.mGetInstallPath = installPath;
    this.mQueue = Promise.resolve();
  }

  /**
   * add an installer extension
   *
   * @param {number} priority priority of the installer. the lower the number the higher
   *                          the priority, so at priority 0 the extension would always be
   *                          the first to be queried
   * @param {TestSupported} testSupported
   * @param {IInstall} install
   *
   * @memberOf InstallManager
   */
  public addInstaller(
    priority: number,
    testSupported: TestSupported,
    install: InstallFunc) {
    this.mInstallers.push({ priority, testSupported, install });
    this.mInstallers.sort((lhs: IModInstaller, rhs: IModInstaller): number => {
      return lhs.priority - rhs.priority;
    });
  }

  /**
   * start installing a mod.
   *
   * @param {string} archiveId id of the download. may be null if the download isn't
   *                           in our download archive
   * @param {string} archivePath path to the archive file
   * @param {string} downloadGameId gameId of the download as reported by the downloader
   * @param {IExtensionApi} extension api
   * @param {*} info existing information about the mod (i.e. stuff retrieved
   *                 from the download page)
   * @param {boolean} processDependencies if true, test if the installed mod is dependent
   *                                      of others and tries to install those too
   * @param {boolean} enable if true, enable the mod after installation
   * @param {Function} callback callback once this is finished
   */
  public install(
    archiveId: string,
    archivePath: string,
    downloadGameId: string,
    api: IExtensionApi,
    info: any,
    processDependencies: boolean,
    enable: boolean,
    callback?: (error: Error, id: string) => void) {

    if (this.mTask === undefined) {
      const Zip: typeof ZipT = require('node-7z');
      this.mTask = new Zip();
    }

    const fullInfo = { ...info };
    let destinationPath: string;
    let tempPath: string;

    const baseName = path.basename(archivePath, path.extname(archivePath));
    const currentProfile = activeProfile(api.store.getState());
    let modId = baseName;
    let installGameId: string;
    let installContext: InstallContext;

    this.mQueue = this.mQueue
      .then(() => this.queryGameId(api.store, downloadGameId))
      .then(gameId => {
        installGameId = gameId;
        if (installGameId === undefined) {
          return Promise.reject(
            new ProcessCanceled('You need to select a game before installing this mod'));
        }
        installContext = new InstallContext(gameId, api);
        installContext.startIndicator(baseName);
        return api.lookupModMeta({ filePath: archivePath, gameId });
      })
      .then((modInfo: ILookupResult[]) => {
        if (modInfo.length > 0) {
          fullInfo.meta = modInfo[0].value;
        }

        modId = this.deriveInstallName(baseName, fullInfo);
        // if the name is already taken, consult the user,
        // repeat until user canceled, decided to replace the existing
        // mod or provided a new, unused name
        const checkNameLoop = () => this.checkModExists(modId, api, installGameId)
          ? this.queryUserReplace(modId, installGameId, api)
            .then((choice: { name: string, enable: boolean }) => {
              modId = choice.name;
              if (choice.enable) {
                enable = true;
              }
              return checkNameLoop();
            })
          : Promise.resolve(modId);

        return checkNameLoop();
      })
      // TODO: this is only necessary to get at the fileId and the fileId isn't
      //   even a particularly good way to discover conflicts
      .then(() => filterModInfo(fullInfo, undefined))
      .then(modInfo => {
        const oldMod = (modInfo.fileId !== undefined)
          ? this.findPreviousVersionMod(modInfo.fileId, api.store, installGameId)
          : undefined;

        if (oldMod !== undefined) {
          const wasEnabled = getSafe(currentProfile.modState, [oldMod.id, 'enabled'], false);
          return this.userVersionChoice(oldMod, api.store)
            .then((action: string) => {
              if (action === 'Install') {
                enable = enable || wasEnabled;
                if (wasEnabled) {
                  setModEnabled(currentProfile.id, oldMod.id, false);
                }
                return Promise.resolve();
              } else if (action === 'Replace') {
                // we need to remove the old mod before continuing. This ensures
                // the mod is deactivated and undeployed (as to not leave dangling
                // links) and it ensures we do a clean install of the mod
                return new Promise<void>((resolve, reject) => {
                  api.events.emit('remove-mod', currentProfile.gameId, oldMod.id,
                                  (error: Error) => {
                    if (error !== null) {
                      reject(error);
                    } else {
                      // use the same mod id as the old version so that all profiles
                      // keep using it.
                      modId = oldMod.id;
                      enable = enable || wasEnabled;
                      resolve();
                    }
                  });
                });
              }
            });
        } else {
          return Promise.resolve();
        }
      })
      .then(() => {
        installContext.startInstallCB(modId, installGameId, archiveId);

        destinationPath = path.join(this.mGetInstallPath(installGameId), modId);
        tempPath = destinationPath + '.installing';
        return this.installInner(api, archivePath,
          tempPath, destinationPath, installGameId);
      })
      .then(result => {
        installContext.setInstallPathCB(modId, destinationPath);
        const state: IState = api.store.getState();

        if (state.persistent.mods[installGameId][modId].type === '') {
          return this.determineModType(installGameId, result.instructions)
              .then(type => {
                installContext.setModType(modId, type);
                return result;
              });
        } else {
          return Promise.resolve(result);
        }
      })
      .then(result => this.processInstructions(api, archivePath, tempPath, destinationPath,
                                               installGameId, modId, result))
      .finally(() => (tempPath !== undefined)
        ? rimrafAsync(tempPath, { glob: false })
        : Promise.resolve())
      .then(() => filterModInfo(fullInfo, destinationPath))
      .then(modInfo => {
        installContext.finishInstallCB('success', modInfo);
        if (enable) {
          api.store.dispatch(setModEnabled(currentProfile.id, modId, true));
        }
        if (processDependencies) {
          log('info', 'process dependencies', { modId });
          this.installDependencies(modInfo.rules, this.mGetInstallPath(installGameId),
            installContext, api);
        }
        if (callback !== undefined) {
          callback(null, modId);
        }
        return null;
      })
      .catch(err => {
        // TODO: make this nicer. especially: The first check doesn't recognize UserCanceled
        //   exceptions from extensions, hence we have to do the string check (last one)
        const canceled = (err instanceof UserCanceled)
                         || (err instanceof ProcessCanceled)
                         || (err === null)
                         || (err.message === 'Canceled')
                         || ((err.stack !== undefined)
                             && err.stack.startsWith('UserCanceled: canceled by user'));
        let prom = destinationPath !== undefined
          ? rimrafAsync(destinationPath, { glob: false, maxBusyTries: 1 })
          : Promise.resolve();

        if (installContext !== undefined) {
          // context doesn't have to be set if we canceled early
          prom = prom.then(() => installContext.finishInstallCB(
                               canceled ? 'canceled' : 'failed'));
        }

        if (err === undefined) {
          return prom.then(() => {
            if (callback !== undefined) {
              callback(new Error('unknown error'), null);
            }
          });
        } else if (canceled) {
          return prom.then(() => {
            if (callback !== undefined) {
              callback(err, null);
            }
          });
        } else if (err instanceof ArchiveBrokenError) {
          return prom
            .then(() => {
              if (installContext !== undefined) {
                installContext.reportError(
                  'Installation failed',
                  `The archive ${path.basename(archivePath)} is damaged and couldn't be installed. `
                  + 'This is most likely fixed by re-downloading the file.', false);
              }
            });
        } else {
          const { genHash } = require('modmeta-db');
          const errMessage = typeof err === 'string' ? err : err.message + '\n' + err.stack;

          return prom
            .then(() => genHash(archivePath))
            .then((hashResult: IHashResult) => {
              const id = `${path.basename(archivePath)} (md5: ${hashResult.md5sum})`;
              if (installContext !== undefined) {
                installContext.reportError(
                    'Installation failed',
                    `The installer "${id}" failed: ${errMessage}`, err.code !== 'EPERM');
              }
              if (callback !== undefined) {
                callback(err, modId);
              }
            });
        }
      })
      .finally(() => {
        if (installContext !== undefined) {
          installContext.stopIndicator();
        }
      });
  }

  private isCritical(error: string): boolean {
    return (error.indexOf('Unexpected end of archive') !== -1)
        || (error.indexOf('ERROR: Data Error') !== -1);
  }

  /**
   * find the right installer for the specified archive, then install
   */
  private installInner(api: IExtensionApi, archivePath: string,
                       tempPath: string, destinationPath: string,
                       gameId: string): Promise<IInstallResult> {
    const fileList: string[] = [];
    return this.mTask.extractFull(archivePath, tempPath, {ssc: false},
                                  () => undefined,
                                  () => this.queryPassword(api.store))
        .catch((err: Error) => this.isCritical(err.message)
          ? Promise.reject(new ArchiveBrokenError())
          : Promise.reject(err))
        .then(({ code, errors }: {code: number, errors: string[] }) => {
          if (code !== 0) {
            const critical = errors.find(this.isCritical);
            if (critical !== undefined) {
              return Promise.reject(new ArchiveBrokenError());
            }
            return this.queryContinue(api, errors);
          } else {
            return Promise.resolve();
          }
        })
        .then(() => walk(tempPath,
                         (iterPath, stats) => {
                           if (stats.isFile()) {
                             fileList.push(path.relative(tempPath, iterPath));
                           } else {
                             // unfortunately we also have to pass directories because
                             // some mods contain empty directories to control stop-folder
                             // management...
                             fileList.push(path.relative(tempPath, iterPath) + path.sep);
                           }
                           return Promise.resolve();
                         }))
        .then(() => this.getInstaller(fileList, gameId))
        .then(supportedInstaller => {
          if (supportedInstaller === undefined) {
            throw new Error('no installer supporting this file');
          }

          const {installer, requiredFiles} = supportedInstaller;
          return installer.install(
              fileList, tempPath, gameId,
              (perc: number) => log('info', 'progress', perc));
        });
  }

  private determineModType(gameId: string, installInstructions: IInstruction[]): Promise<string> {
    log('info', 'determine mod type', { gameId });
    const modTypes: IModType[] = getGame(gameId).modTypes;
    // sort with priority descending so we can stop as soon as we've hit the first match
    const sorted = modTypes.sort((lhs, rhs) => rhs.priority - lhs.priority);
    let found = false;
    return Promise.mapSeries(sorted, (type: IModType): Promise<string> => {
      if (found) {
        return Promise.resolve<string>(null);
      }

      return type.test(installInstructions)
      .then(matches => {
        if (matches) {
          found = true;
          return Promise.resolve(type.typeId);
        } else {
          return Promise.resolve(null);
        }
      });
    }).then(matches => matches.find(match => match !== null) || '');
  }

  private queryContinue(api: IExtensionApi,
                        errors: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      api.store.dispatch(showDialog('error', api.translate('Archive damaged'), {
        bbcode: api.translate('Encountered errors extracting this archive. Please verify this '
                  + 'file was downloaded correctly.\n[list]{{ errors }}[/list]', {
                  replace: { errors: errors.map(err => '[*] ' + err) } }),
        options: { translated: true },
      }, [
          { label: 'Cancel', action: () => reject(new UserCanceled()) },
          { label: 'Continue', action: () => resolve() },
        ]));
    });
  }

  private queryGameId(store: Redux.Store<any>,
                      downloadGameId: string): Promise<string> {
    const currentGameId = activeGameId(store.getState());
    if (currentGameId === undefined) {
      return Promise.resolve(downloadGameId);
    }
    return new Promise<string>((resolve, reject) => {
      if (getSafe(store.getState(),
                  ['settings', 'gameMode', 'discovered', downloadGameId],
                  undefined) === undefined) {
        const btnLabel =
            `Install for "${gameName(store.getState(), currentGameId)}"`;
        store.dispatch(showDialog(
            'question', 'Game not installed',
            {
              message:
                  'The game associated with this download is not discovered.',
            },
            [
              { label: 'Cancel', action: () => reject(new UserCanceled()) },
              { label: btnLabel, action: () => resolve(currentGameId) },
            ]));
      } else if (currentGameId !== downloadGameId) {
        store.dispatch(showDialog(
            'question', 'Download is for a different game',
            {
              message:
                  'This download is associated with a different game than the current.' +
                      'Which one do you want to install it for?',
            },
            [
              { label: 'Cancel', action: () => reject(new UserCanceled()) },
              { label: gameName(store.getState(), currentGameId), action:
                  () => resolve(currentGameId) },
              { label: gameName(store.getState(), downloadGameId), action:
                  () => resolve(downloadGameId) },
            ]));
      } else {
        resolve(downloadGameId);
      }
    });
  }

  private queryPassword(store: Redux.Store<any>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      store
          .dispatch(showDialog(
              'info', 'Password Protected',
              {
                input: [{
                  id: 'password',
                  type: 'password',
                  value: '',
                  label: 'A password is required to extract this archive',
                }],
              }, [ { label: 'Cancel' }, { label: 'Continue' } ]))
          .then((result: IDialogResult) => {
            if (result.action === 'Continue') {
              resolve(result.input['password']);
            } else {
              reject(new UserCanceled());
            }
          });
    });
  }

  private transformInstructions(input: IInstruction[]): InstructionGroups {
    return input.reduce((prev, value) => {
      if (prev[value.type] !== undefined) {
        prev[value.type].push(value);
      }
      return prev;
    }, new InstructionGroups());
  }

  private reportUnsupported(api: IExtensionApi, unsupported: IInstruction[], archivePath: string) {
    if (unsupported.length === 0) {
      return;
    }
    const missing = unsupported.map(instruction => instruction.source);
    const {genHash} = require('modmeta-db');
    const makeReport = () =>
        genHash(archivePath)
            .then(
                (hashResult: IHashResult) => createErrorReport(
                    'Installer failed',
                    {
                      message: 'The installer uses unimplemented functions',
                      details:
                          `Missing instructions: ${missing.join(', ')}\n` +
                              `Installer name: ${path.basename(archivePath)}\n` +
                              `MD5 checksum: ${hashResult.md5sum}\n`,
                    },
                    ['installer']));
    const showUnsupportedDialog = () => api.store.dispatch(showDialog(
        'info', 'Installer unsupported',
        {
          message:
              'This installer is (partially) unsupported as it\'s ' +
              'using functionality that hasn\'t been implemented yet. ' +
              'Please help us fix this by submitting an error report with a link to this mod.',
        }, [
          { label: 'Report', action: makeReport },
          { label: 'Close' },
        ]));

    api.sendNotification({
      type: 'info',
      message: 'Installer unsupported',
      actions: [{title: 'More', action: showUnsupportedDialog}],
    });
  }

  private processMKDir(instructions: IInstruction[],
                       destinationPath: string): Promise<void> {
    return Promise.each(instructions,
                        instruction => fs.ensureDirAsync(path.join(
                            destinationPath, instruction.destination)))
        .then(() => undefined);
  }

  private processGenerateFiles(generatefile: IInstruction[],
                               destinationPath: string): Promise<void> {
    return Promise.each(generatefile, gen => {
                    const outputPath =
                        path.join(destinationPath, gen.destination);
                    return fs.ensureDirAsync(path.dirname(outputPath))
                        .then(() => fs.writeFileAsync(outputPath, gen.source));
                  }).then(() => undefined);
  }

  private processSubmodule(api: IExtensionApi, submodule: IInstruction[],
                           destinationPath: string,
                           gameId: string, modId: string): Promise<void> {
    return Promise.each(submodule,
      mod => {
        const tempPath = destinationPath + '.' + mod.key + '.installing';
        return this.installInner(api, mod.path, tempPath, destinationPath, gameId)
          .then((resultInner) => this.processInstructions(
            api, mod.path, tempPath, destinationPath,
            gameId, mod.key, resultInner))
          .then(() => {
            if (mod.submoduleType !== undefined) {
              api.store.dispatch(setModType(gameId, modId, mod.submoduleType));
            }
          })
          .finally(() => rimrafAsync(tempPath, { glob: false, maxBusyTries: 1 }));
      })
        .then(() => undefined);
  }

  private processAttribute(api: IExtensionApi, attribute: IInstruction[],
                           gameId: string, modId: string): Promise<void> {
    attribute.forEach(attr => {
      api.store.dispatch(setModAttribute(gameId, modId, attr.key, attr.value));
    });
    return Promise.resolve();
  }

  private processSetModType(api: IExtensionApi, types: IInstruction[],
                            gameId: string, modId: string): Promise<void> {
    if (types.length > 0) {
      api.store.dispatch(setModType(gameId, modId, types[types.length - 1].value));
      if (types.length > 1) {
        log('error', 'got more than one mod type, only the last was used', { types });
      }
    }
    return Promise.resolve();
  }

  private processIniEdits(iniEdits: IInstruction[], destinationPath: string): Promise<void> {
    if (iniEdits.length === 0) {
      return Promise.resolve();
    }

    const byDest: { [dest: string]: IInstruction[] } = iniEdits.reduce((prev, value) => {
      setdefault(prev, value.destination, []).push(value);
      return prev;
    }, {});

    return fs.ensureDirAsync(path.join(destinationPath, INI_TWEAKS_PATH))
      .then(() => Promise.map(Object.keys(byDest), destination => {
      const bySection: {[section: string]: IInstruction[]} =
          byDest[destination].reduce((prev, value) => {
            setdefault(prev, value.section, []).push(value);
            return prev;
          }, {});

      const renderKV = (instruction: IInstruction): string =>
          `${instruction.key} = ${instruction.value}`;

      const renderSection = (section: string) => [
        `[${section}]`,
      ].concat(bySection[section].map(renderKV)).join(os.EOL);

      const content = Object.keys(bySection).map(renderSection).join(os.EOL);

      return fs.writeFileAsync(path.join(destinationPath, INI_TWEAKS_PATH, destination), content);
    }))
    .then(() => undefined);
  }

  private processInstructions(api: IExtensionApi, archivePath: string,
                              tempPath: string, destinationPath: string,
                              gameId: string, modId: string,
                              result: { instructions: IInstruction[] }) {
    if (result.instructions === null) {
      // this is the signal that the installer has already reported what went
      // wrong. Not necessarily a "user canceled" but the error handling happened
      // in the installer so we don't know what happened.
      return Promise.reject(new UserCanceled());
    }

    if ((result.instructions === undefined) ||
        (result.instructions.length === 0)) {
      return Promise.reject('installer returned no instructions');
    }

    const instructionGroups = this.transformInstructions(result.instructions);

    if (instructionGroups.error.length > 0) {
      api.showErrorNotification('Installer failed',
        instructionGroups.error.map(err => err.source).join('\n'), {
          allowReport: false,
        },
      );
      return Promise.reject(new ProcessCanceled('Installer failed'));
    }

    log('debug', 'installer instructions', instructionGroups);
    this.reportUnsupported(api, instructionGroups.unsupported, archivePath);

    return this.processMKDir(instructionGroups.mkdir, destinationPath)
      .then(() => this.extractArchive(api, archivePath, tempPath, destinationPath,
                                      instructionGroups.copy))
      .then(() => this.processGenerateFiles(instructionGroups.generatefile,
                                            destinationPath))
      .then(() => this.processIniEdits(instructionGroups.iniedit, destinationPath))
      .then(() => this.processSubmodule(api, instructionGroups.submodule,
                                        destinationPath, gameId, modId))
      .then(() => this.processAttribute(api, instructionGroups.attribute, gameId, modId))
      .then(() => this.processSetModType(api, instructionGroups.attribute, gameId, modId))
      ;
    }

  private checkModExists(installName: string, api: IExtensionApi, gameMode: string): boolean {
    return installName in (api.store.getState().persistent.mods[gameMode] || {});
  }

  private findPreviousVersionMod(fileId: number, store: Redux.Store<any>,
                                 gameMode: string): IMod {
    const mods = store.getState().persistent.mods[gameMode] || {};
    let mod: IMod;
    Object.keys(mods).forEach(key => {
      const newestFileId: number = getSafe(mods[key].attributes, ['newestFileId'], undefined);
      const currentFileId: number = getSafe(mods[key].attributes, ['fileId'], undefined);
      if (newestFileId !== currentFileId && newestFileId === fileId) {
        mod = mods[key];
      }
    });

    return mod;
  }

  private userVersionChoice(oldMod: IMod, store: Redux.Store<any>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      store.dispatch(showDialog(
          'question', modName(oldMod),
          {
            message:
            'An older version of this mod is already installed.' +
            'You can replace the existing one or install this one alongside it. ' +
            'If you have other profiles they will continue using the old version.',
            options: { wrap: true },
          },
          [
            { label: 'Cancel' },
            { label: 'Replace' },
            { label: 'Install' },
          ]))
        .then((result: IDialogResult) => {
          if (result.action === 'Cancel') {
            reject(new UserCanceled());
          } else {
            resolve(result.action);
          }
        });
    });
  }

  private queryUserReplace(modId: string, gameId: string, api: IExtensionApi) {
    return new Promise<{ name: string, enable: boolean }>((resolve, reject) => {
      api.store
        .dispatch(showDialog(
          'question', 'Mod exists',
          {
            message:
            'This mod seems to be installed already. You can replace the ' +
            'existing one or install the new one under a different name ' +
            '(this name is used internally, you can still change the display name ' +
            'to anything you want later).',
            input: [{
              id: 'newName',
              value: modId,
              label: 'Name',
            }],
            options: {
              wrap: true,
            },
          },
          [
            { label: 'Cancel' },
            { label: 'Rename' },
            { label: 'Replace' },
          ]))
        .then((result: IDialogResult) => {
          if (result.action === 'Cancel') {
            reject(new UserCanceled());
          } else if (result.action === 'Rename') {
            resolve({ name: result.input.newName, enable: false });
          } else if (result.action === 'Replace') {
            const currentProfile = activeProfile(api.store.getState());
            const wasEnabled = (currentProfile !== undefined) && (currentProfile.gameId === gameId)
              ? getSafe(currentProfile.modState, [modId, 'enabled'], false)
              : false;
            api.events.emit('remove-mod', gameId, modId, (err) => {
              if (err !== null) {
                reject(err);
              } else {
                resolve({ name: modId, enable: wasEnabled });
              }
            });
          }
        });
    });
  }

  private getInstaller(
    fileList: string[],
    gameId: string,
    offsetIn?: number): Promise<ISupportedInstaller> {
    const offset = offsetIn || 0;
    if (offset >= this.mInstallers.length) {
      return Promise.resolve(undefined);
    }
    return this.mInstallers[offset].testSupported(fileList, gameId)
      .then((testResult: ISupportedResult) => (testResult.supported === true)
          ? Promise.resolve({
              installer: this.mInstallers[offset],
              requiredFiles: testResult.requiredFiles,
            })
          : this.getInstaller(fileList, gameId, offset + 1));
 }

  /**
   * determine the mod name (on disk) from the archive path
   * TODO: this currently simply uses the archive name which should be fine
   *   for downloads from nexus but in general we need the path to encode the
   *   mod, the specific "component" and the version. And then we need to avoid
   *   collisions.
   *   Finally, the way I know users they will want to customize this.
   *
   * @param {string} archiveName
   * @param {*} info
   * @returns
   */
  private deriveInstallName(archiveName: string, info: any) {
    return deriveModInstallName(archiveName, info);
  }

  private downloadModAsync(
    requirement: IReference,
    sourceURI: string,
    api: IExtensionApi): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!api.events.emit('start-download', [sourceURI], {}, undefined,
        (error, id) => {
          if (error === null) {
            resolve(id);
          } else {
            reject(error);
          }
        })) {
        reject(new Error('download manager not installed?'));
      }
    });
  }

  private doInstallDependencies(
    dependencies: IDependency[],
    api: IExtensionApi): Promise<void> {
    return Promise.all(dependencies.map((dep: IDependency) => {
      if (dep.download === undefined) {
        return this.downloadModAsync(
          dep.reference,
          dep.lookupResults[0].value.sourceURI,
          api)
          .then((downloadId: string) => {
            return this.installModAsync(dep.reference, api,
              downloadId);
          });
      } else {
        return this.installModAsync(dep.reference, api,
          dep.download);
      }
    }))
      .catch((err) => {
        api.showErrorNotification('Failed to install dependencies',
          err.message);
      })
      .then(() => undefined);
  }

  private installDependencies(
    rules: IRule[],
    installPath: string,
    installContext: InstallContext,
    api: IExtensionApi): Promise<void> {
    const notificationId = `${installPath}_activity`;
    api.sendNotification({
      id: notificationId,
      type: 'activity',
      message: 'Checking dependencies',
    });
    return gatherDependencies(rules, api)
      .then((dependencies: IDependency[]) => {
        api.dismissNotification(notificationId);

        if (dependencies.length === 0) {
          return Promise.resolve();
        }

        const requiredDownloads =
          dependencies.reduce((prev: number, current: IDependency) => {
            return prev + (current.download ? 0 : 1);
          }, 0);

        return new Promise<void>((resolve, reject) => {
          const message =
            `This mod has unresolved dependencies. ${dependencies.length} mods have to be
installed, ${requiredDownloads} of them have to be downloaded first.`;

          api.store.dispatch(
              showDialog('question', 'Install Dependencies', {message}, [
                {label: 'Don\'t install'},
                {
                  label: 'Install',
                  action: () => this.doInstallDependencies(dependencies, api),
                },
              ]));
        });
      })
      .catch((err) => {
        api.dismissNotification(notificationId);
        api.showErrorNotification('Failed to check dependencies', err);
      });
  }

  private installModAsync(
    requirement: IReference,
    api: IExtensionApi,
    downloadId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const state = api.store.getState();
      const download: IDownload = state.persistent.downloads.files[downloadId];
      const fullPath: string = path.join(downloadPath(state), download.localPath);
      this.install(downloadId, fullPath, download.game || activeGameId(state),
        api, { download }, false, false, (error, id) => {
          if (error === null) {
            resolve(id);
          } else {
            reject(error);
          }
        });
    });
  }

  private transferFile(source: string, destination: string, move: boolean): Promise<void> {
    const command = move ? fs.renameAsync : fs.copyAsync;
    return fs.ensureDirAsync(path.dirname(destination))
      .then(() => command(source, destination))
      .catch(err => {
        return err.code === 'EPERM'
        ? Promise.delay(100).then(() => command(source, destination))
        : Promise.reject(err);
      });
  }

  /**
   * extract an archive
   *
   * @export
   * @param {string} archivePath path to the archive file
   * @param {string} destinationPath path to install to
   */
  private extractArchive(
    api: IExtensionApi,
    archivePath: string,
    tempPath: string,
    destinationPath: string,
    copies: IInstruction[]): Promise<void> {
    let normalize: Normalize;

    const missingFiles: string[] = [];
    return fs.ensureDirAsync(destinationPath)
        .then(() => getNormalizeFunc(destinationPath))
        .then((normalizeFunc: Normalize) => {
          normalize = normalizeFunc;
        })
        .then(() => {
          const sourceMap: {[src: string]: string[]} =
              copies.reduce((prev, copy) => {
                setdefault(prev, copy.source, []).push(copy.destination);
                return prev;
              }, {});
          // for each source, copy or rename to destination(s)
          return Promise.mapSeries(Object.keys(sourceMap), srcRel => {
            const sourcePath = path.join(tempPath, srcRel);
            // need to do this sequentially, otherwise we can't use the idx to
            // decide between rename and copy
            return Promise.mapSeries(sourceMap[srcRel], (destRel, idx, len) => {
              const destPath = path.join(destinationPath, destRel);
              return this.transferFile(sourcePath, destPath, idx === len - 1)
                .catch(err => {
                  if (err.code === 'ENOENT') {
                    missingFiles.push(srcRel);
                  } else {
                    return Promise.reject(err);
                  }
                });
            });
          });
        })
        .then(() => {
          if (missingFiles.length > 0) {
            api.showErrorNotification(api.translate('Invalid installer'),
              api.translate('The installer in "{{name}}" tried to install files that were '
                            + 'not part of the archive.\nThis is a bug in the mod, please '
                            + 'report it to the mod author.\n'
                            + 'Please note: NMM silently ignores this kind of errors so you '
                            + 'might get this message for mods that appear to install '
                            + 'fine with NMM. The mod will likely work, at least partially.',
                          { replace: {name: path.basename(archivePath)} })
              + '\n\n' + missingFiles.map(name => '- ' + name).join('\n')
            , { allowReport: false });
          }
        });
  }
}

export default InstallManager;
