﻿/// <reference path="../../definitions/generated/code-push.d.ts" />

import * as base64 from "base-64";
import * as chalk from "chalk";
import * as fs from "fs";
import * as moment from "moment";
var opener = require("opener");
import * as os from "os";
import * as path from "path";
var prompt = require("prompt");
import * as Q from "q";
import * as recursiveFs from "recursive-fs";
import * as semver from "semver";
import slash = require("slash");
import tryJSON = require("try-json");
var Table = require("cli-table");
import * as yazl from "yazl";
import wordwrap = require("wordwrap");

import * as cli from "../definitions/cli";
import * as AccountManager from "code-push";
import { AccessKey, AccountManager, App, Deployment, DeploymentKey, Package } from "code-push";
var packageJson = require("../package.json");
import Promise = Q.Promise;
var progress = require("progress");

var configFilePath: string = path.join(process.env.LOCALAPPDATA || process.env.HOME, ".code-push.config");
var userAgent: string = packageJson.name + "/" + packageJson.version;

interface ILegacyLoginConnectionInfo {
    accessKeyName: string;
    providerName: string;
    providerUniqueId: string;
    serverUrl: string;
}

interface ILoginConnectionInfo {
    accessKey: string;
    serverUrl: string;
}

interface IPackageFile {
    isTemporary: boolean;
    path: string;
}

// Exported variables for unit testing.
export var sdk: AccountManager;
export var log = (message: string | Chalk.ChalkChain): void => console.log(message);

export var confirm = (): Promise<boolean> => {
    return Promise<boolean>((resolve, reject, notify): void => {
        prompt.message = "";
        prompt.delimiter = "";

        prompt.start();

        prompt.get({
            properties: {
                response: {
                    description: chalk.cyan("Are you sure? (Y/n):")
                }
            }
        }, (err: any, result: any): void => {
            if (!result.response || result.response === "" || result.response === "Y") {
                resolve(true);
            } else {
                if (result.response !== "n") console.log("Invalid response: \"" + result.response + "\"");
                resolve(false);
            }
        });
    });
}

function accessKeyAdd(command: cli.IAccessKeyAddCommand): Promise<void> {
    var hostname: string = os.hostname();
    return sdk.addAccessKey(hostname, command.description)
        .then((accessKey: AccessKey) => {
            log("Successfully created a new access key" + (command.description ? (" \"" + command.description + "\"") : "") + ": " + accessKey.name);
        });
}

function accessKeyList(command: cli.IAccessKeyListCommand): Promise<void> {
    throwForInvalidOutputFormat(command.format);

    return sdk.getAccessKeys()
        .then((accessKeys: AccessKey[]): void => {
            printAccessKeys(command.format, accessKeys);
        });
}

function accessKeyRemove(command: cli.IAccessKeyRemoveCommand): Promise<void> {
    if (command.accessKey === sdk.accessKey) {
        throw new Error("Cannot remove the access key for the current session. Please run 'code-push logout' if you would like to remove this access key.");
    } else {
        return getAccessKeyId(command.accessKey)
            .then((accessKeyId: string): Promise<void> => {
                throwForInvalidAccessKeyId(accessKeyId, command.accessKey);

                return confirm()
                    .then((wasConfirmed: boolean): Promise<void> => {
                        if (wasConfirmed) {
                            return sdk.removeAccessKey(accessKeyId)
                                .then((): void => {
                                    log("Successfully removed the \"" + command.accessKey + "\" access key.");
                                });
                        }

                        log("Access key removal cancelled.");
                    });
            });
    }
}

function appAdd(command: cli.IAppAddCommand): Promise<void> {
    return sdk.addApp(command.appName)
        .then((app: App): Promise<void> => {
            log("Successfully added the \"" + command.appName + "\" app, along with the following default deployments:");
            var deploymentListCommand: cli.IDeploymentListCommand = {
                type: cli.CommandType.deploymentList,
                appName: app.name,
                format: "table"
            };
            return deploymentList(deploymentListCommand, /*showPackage=*/ false);
        });
}

function appList(command: cli.IAppListCommand): Promise<void> {
    throwForInvalidOutputFormat(command.format);
    var apps: App[];

    return sdk.getApps()
        .then((retrievedApps: App[]): Promise<string[][]> => {
            apps = retrievedApps;
            var deploymentListPromises: Promise<string[]>[] = apps.map((app: App) => {
                return sdk.getDeployments(app.id)
                    .then((deployments: Deployment[]) => {
                        var deploymentList: string[] = deployments
                            .map((deployment: Deployment) => deployment.name)
                            .sort((first: string, second: string) => {
                                return first.toLowerCase().localeCompare(second.toLowerCase());
                            });
                        return deploymentList;
                    });
            });
            return Q.all(deploymentListPromises);
        })
        .then((deploymentLists: string[][]): void => {
            printAppList(command.format, apps, deploymentLists);
        });
}

function appRemove(command: cli.IAppRemoveCommand): Promise<void> {
    return getAppId(command.appName)
        .then((appId: string): Promise<void> => {
            throwForInvalidAppId(appId, command.appName);

            return confirm()
                .then((wasConfirmed: boolean): Promise<void> => {
                    if (wasConfirmed) {
                        return sdk.removeApp(appId)
                            .then((): void => {
                                log("Successfully removed the \"" + command.appName + "\" app.");
                            });
                    }

                    log("App removal cancelled.");
                });
        });
}

function appRename(command: cli.IAppRenameCommand): Promise<void> {
    return getApp(command.currentAppName)
        .then((app: App): Promise<void> => {
            throwForInvalidApp(app, command.currentAppName);

            app.name = command.newAppName;

            return sdk.updateApp(app);
        })
        .then((): void => {
            log("Successfully renamed the \"" + command.currentAppName + "\" app to \"" + command.newAppName + "\".");
        });
}

function deleteConnectionInfoCache(): void {
    try {
        fs.unlinkSync(configFilePath);

        log("Successfully logged-out. The session token file located at " + chalk.cyan(configFilePath) + " has been deleted.\r\n");
    } catch (ex) {
    }
}

function deploymentAdd(command: cli.IDeploymentAddCommand): Promise<void> {
    return getAppId(command.appName)
        .then((appId: string): Promise<void> => {
            throwForInvalidAppId(appId, command.appName);

            return sdk.addDeployment(appId, command.deploymentName)
                .then((deployment: Deployment): Promise<DeploymentKey[]> => {
                    return sdk.getDeploymentKeys(appId, deployment.id);
                }).then((deploymentKeys: DeploymentKey[]) => {
                    log("Successfully added the \"" + command.deploymentName + "\" deployment with key \"" + deploymentKeys[0].key + "\" to the \"" + command.appName + "\" app.");
                });
        })
}

export var deploymentList = (command: cli.IDeploymentListCommand, showPackage: boolean = true): Promise<void> => {
    throwForInvalidOutputFormat(command.format);
    var theAppId: string;

    return getAppId(command.appName)
        .then((appId: string): Promise<Deployment[]> => {
            throwForInvalidAppId(appId, command.appName);
            theAppId = appId;

            return sdk.getDeployments(appId);
        })
        .then((deployments: Deployment[]): Promise<void> => {
            var deploymentKeyPromises: Promise<string>[] = deployments.map((deployment: Deployment) => {
                return sdk.getDeploymentKeys(theAppId, deployment.id)
                    .then((deploymentKeys: DeploymentKey[]): string => {
                        return deploymentKeys[0].key;
                    });
            });
            return Q.all(deploymentKeyPromises)
                .then((deploymentKeyList: string[]) => {
                    printDeploymentList(command, deployments, deploymentKeyList, showPackage);
                });
        });
}

function deploymentRemove(command: cli.IDeploymentRemoveCommand): Promise<void> {
    return getAppId(command.appName)
        .then((appId: string): Promise<void> => {
            throwForInvalidAppId(appId, command.appName);

            return getDeploymentId(appId, command.deploymentName)
                .then((deploymentId: string): Promise<void> => {
                    throwForInvalidDeploymentId(deploymentId, command.deploymentName, command.appName);

                    return confirm()
                        .then((wasConfirmed: boolean): Promise<void> => {
                            if (wasConfirmed) {
                                return sdk.removeDeployment(appId, deploymentId)
                                    .then((): void => {
                                        log("Successfully removed the \"" + command.deploymentName + "\" deployment from the \"" + command.appName + "\" app.");
                                    })
                            }

                            log("Deployment removal cancelled.");
                        });
                });
        });
}

function deploymentRename(command: cli.IDeploymentRenameCommand): Promise<void> {
    return getAppId(command.appName)
        .then((appId: string): Promise<void> => {
            throwForInvalidAppId(appId, command.appName);

            return getDeployment(appId, command.currentDeploymentName)
                .then((deployment: Deployment): Promise<void> => {
                    throwForInvalidDeployment(deployment, command.currentDeploymentName, command.appName);

                    deployment.name = command.newDeploymentName;

                    return sdk.updateDeployment(appId, deployment);
                })
                .then((): void => {
                    log("Successfully renamed the \"" + command.currentDeploymentName + "\" deployment to \"" + command.newDeploymentName + "\" for the \"" + command.appName + "\" app.");
                });
        });
}

function deploymentHistory(command: cli.IDeploymentHistoryCommand): Promise<void> {
    throwForInvalidOutputFormat(command.format);
    var storedAppId: string;

    return getAppId(command.appName)
        .then((appId: string): Promise<string> => {
            throwForInvalidAppId(appId, command.appName);
            storedAppId = appId;

            return getDeploymentId(appId, command.deploymentName);
        })
        .then((deploymentId: string): Promise<Package[]> => {
            throwForInvalidDeploymentId(deploymentId, command.deploymentName, command.appName);

            return sdk.getPackageHistory(storedAppId, deploymentId);
        })
        .then((packageHistory: Package[]): void => {
            printDeploymentHistory(command, packageHistory);
        });
}

function deserializeConnectionInfo(): ILegacyLoginConnectionInfo|ILoginConnectionInfo {
    var savedConnection: string;

    try {
        savedConnection = fs.readFileSync(configFilePath, { encoding: "utf8" });
    } catch (ex) {
        return;
    }

    var connectionInfo: ILegacyLoginConnectionInfo|ILoginConnectionInfo = tryJSON(savedConnection);
    return connectionInfo;
}

export function execute(command: cli.ICommand): Promise<void> {
    var connectionInfo: ILegacyLoginConnectionInfo|ILoginConnectionInfo = deserializeConnectionInfo();

    return Q(<void>null)
        .then(() => {
            switch (command.type) {
                case cli.CommandType.login:
                case cli.CommandType.register:
                    if (connectionInfo) {
                        throw new Error("You are already logged in from this machine.");
                    }
                    break;

                default:
                    if (!!sdk) break; // Used by unit tests to skip authentication

                    if (!connectionInfo) {
                        throw new Error("You are not currently logged in. Run the 'code-push login' command to authenticate with the CodePush server.");
                    }

                    var accessKey: string = getAccessKeyFromConnectionInfo(connectionInfo);
                    sdk = new AccountManager(accessKey, userAgent, connectionInfo.serverUrl);
                    break;
            }

            switch (command.type) {
                case cli.CommandType.accessKeyAdd:
                    return accessKeyAdd(<cli.IAccessKeyAddCommand>command);

                case cli.CommandType.accessKeyList:
                    return accessKeyList(<cli.IAccessKeyListCommand>command);

                case cli.CommandType.accessKeyRemove:
                    return accessKeyRemove(<cli.IAccessKeyRemoveCommand>command);

                case cli.CommandType.appAdd:
                    return appAdd(<cli.IAppAddCommand>command);

                case cli.CommandType.appList:
                    return appList(<cli.IAppListCommand>command);

                case cli.CommandType.appRemove:
                    return appRemove(<cli.IAppRemoveCommand>command);

                case cli.CommandType.appRename:
                    return appRename(<cli.IAppRenameCommand>command);

                case cli.CommandType.deploymentAdd:
                    return deploymentAdd(<cli.IDeploymentAddCommand>command);

                case cli.CommandType.deploymentList:
                    return deploymentList(<cli.IDeploymentListCommand>command);

                case cli.CommandType.deploymentRemove:
                    return deploymentRemove(<cli.IDeploymentRemoveCommand>command);

                case cli.CommandType.deploymentRename:
                    return deploymentRename(<cli.IDeploymentRenameCommand>command);

                case cli.CommandType.deploymentHistory:
                    return deploymentHistory(<cli.IDeploymentHistoryCommand>command);

                case cli.CommandType.login:
                    return login(<cli.ILoginCommand>command);

                case cli.CommandType.logout:
                    return logout(<cli.ILogoutCommand>command);

                case cli.CommandType.promote:
                    return promote(<cli.IPromoteCommand>command);

                case cli.CommandType.register:
                    return register(<cli.IRegisterCommand>command);

                case cli.CommandType.release:
                    return release(<cli.IReleaseCommand>command);

                case cli.CommandType.rollback:
                    return rollback(<cli.IRollbackCommand>command);

                default:
                    // We should never see this message as invalid commands should be caught by the argument parser.
                    throw new Error("Invalid command:  " + JSON.stringify(command));
            }
        });
}

function generateRandomFilename(length: number): string {
    var filename: string = "";
    var validChar: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (var i = 0; i < length; i++) {
        filename += validChar.charAt(Math.floor(Math.random() * validChar.length));
    }

    return filename;
}

function getAccessKey(accessKeyName: string): Promise<AccessKey> {
    return sdk.getAccessKeys()
        .then((accessKeys: AccessKey[]): AccessKey => {
            for (var i = 0; i < accessKeys.length; ++i) {
                var accessKey: AccessKey = accessKeys[i];

                if (accessKey.name === accessKeyName) {
                    return accessKey;
                }
            }
        });
}

function getAccessKeyId(accessKeyName: string): Promise<string> {
    return getAccessKey(accessKeyName)
        .then((accessKey: AccessKey): string => {
            if (accessKey) {
                return accessKey.id;
            }

            return null;
        });
}

function getApp(appName: string): Promise<App> {
    return sdk.getApps()
        .then((apps: App[]): App => {
            for (var i = 0; i < apps.length; ++i) {
                var app: App = apps[i];

                if (app.name === appName) {
                    return app;
                }
            }
        });
}

function getAppId(appName: string): Promise<string> {
    return getApp(appName)
        .then((app: App): string => {
            if (app) {
                return app.id;
            }

            return null;
        });
}

function getDeployment(appId: string, deploymentName: string): Promise<Deployment> {
    return sdk.getDeployments(appId)
        .then((deployments: Deployment[]): Deployment => {
            for (var i = 0; i < deployments.length; ++i) {
                var deployment: Deployment = deployments[i];

                if (deployment.name === deploymentName) {
                    return deployment;
                }
            }
        });
}

function getDeploymentId(appId: string, deploymentName: string): Promise<string> {
    return getDeployment(appId, deploymentName)
        .then((deployment: Deployment): string => {
            if (deployment) {
                return deployment.id;
            }

            return null;
        });
}

function initiateExternalAuthenticationAsync(serverUrl: string, action: string): void {
    var message: string = `A browser is being launched to authenticate your account. Follow the instructions ` +
                          `it displays to complete your ${action === "register" ? "registration" : "login"}.\r\n`;

    log(message);
    var hostname: string = os.hostname();
    var url: string = serverUrl + "/auth/" + action + "?hostname=" + hostname;
    opener(url);
}

function login(command: cli.ILoginCommand): Promise<void> {
    // Check if one of the flags were provided.
    if (command.accessKey) {
        sdk = new AccountManager(command.accessKey, userAgent, command.serverUrl);
        return sdk.isAuthenticated()
            .then((isAuthenticated: boolean): void => {
                if (isAuthenticated) {
                    serializeConnectionInfo(command.serverUrl, command.accessKey);
                } else {
                    throw new Error("Invalid access key.");
                }
            });
    } else {
        initiateExternalAuthenticationAsync(command.serverUrl, "login");

        return loginWithAccessTokenInternal(command.serverUrl);
    }
}

function loginWithAccessTokenInternal(serverUrl: string): Promise<void> {
    return requestAccessToken()
        .then((accessToken: string): Promise<void> => {
            if (accessToken === null) {
                // The user has aborted the synchronous prompt (e.g.:  via [CTRL]+[C]).
                return;
            }

            var decoded: string = tryBase64Decode(accessToken);
            var connectionInfo: ILegacyLoginConnectionInfo|ILoginConnectionInfo = tryJSON(decoded);
            if (!connectionInfo) {
                throw new Error("Invalid access token.");
            }

            var accessKey: string = getAccessKeyFromConnectionInfo(connectionInfo);
            sdk = new AccountManager(accessKey, userAgent, serverUrl);

            return sdk.isAuthenticated()
                .then((isAuthenticated: boolean): void => {
                    if (isAuthenticated) {
                        serializeConnectionInfo(serverUrl, accessToken);
                    } else {
                        throw new Error("Invalid access token.");
                    }
                });
        });
}

function getAccessKeyFromConnectionInfo(connectionInfo: ILegacyLoginConnectionInfo|ILoginConnectionInfo): string {
    if (!connectionInfo) return null;

    var legacyLoginConnectionInfo: ILegacyLoginConnectionInfo = <ILegacyLoginConnectionInfo>connectionInfo;
    var loginConnectionInfo: ILoginConnectionInfo = <ILoginConnectionInfo>connectionInfo;

    if (legacyLoginConnectionInfo.accessKeyName) {
        return legacyLoginConnectionInfo.accessKeyName;
    } else {
        return loginConnectionInfo.accessKey;
    }
}

function logout(command: cli.ILogoutCommand): Promise<void> {
    return Q(<void>null)
        .then((): Promise<void> => {
            if (!command.isLocal) {
                return sdk.removeAccessKey(sdk.accessKey)
                    .then((): void => {
                        log("Removed access key " + sdk.accessKey + ".");
                        sdk = null;
                    });
            }
        })
        .then((): void => deleteConnectionInfoCache(), (): void => deleteConnectionInfoCache());
}

function formatDate(unixOffset: number): string {
    var date: moment.Moment = moment(unixOffset);
    var now: moment.Moment = moment();
    if (now.diff(date, "days") < 30) {
        return date.fromNow();                  // "2 hours ago"
    } else if (now.year() === date.year()) {
        return date.format("MMM D");            // "Nov 6"
    } else {
        return date.format("MMM D, YYYY");      // "Nov 6, 2014"
    }
}

function printAppList(format: string, apps: App[], deploymentLists: string[][]): void {
    if (format === "json") {
        var dataSource: any[] = apps.map((app: App, index: number) => {
            return { "name": app.name, "deployments": deploymentLists[index] };
        });
        printJson(dataSource);
    } else if (format === "table") {
        var headers = ["Name", "Deployments"];
        printTable(headers, (dataSource: any[]): void => {
            apps.forEach((app: App, index: number): void => {
                var row = [app.name, wordwrap(50)(deploymentLists[index].join(", "))];
                dataSource.push(row);
            });
        });
    }
}

function printDeploymentList(command: cli.IDeploymentListCommand, deployments: Deployment[], deploymentKeys: Array<string>, showPackage: boolean = true): void {
    if (command.format === "json") {
        var dataSource: any[] = deployments.map((deployment: Deployment, index: number) => {
            return { "name": deployment.name, "deploymentKey": deploymentKeys[index], "package": deployment.package };
        });
        printJson(dataSource);
    } else if (command.format === "table") {
        var headers = ["Name", "Deployment Key"];
        if (showPackage) {
            headers.push("Package Metadata");
        }
        printTable(headers, (dataSource: any[]): void => {
            deployments.forEach((deployment: Deployment, index: number): void => {
                var row = [deployment.name, deploymentKeys[index]];
                if (showPackage) {
                    row.push(getPackageString(deployment.package));
                }
                dataSource.push(row);
            });
        });
    }
}

function printDeploymentHistory(command: cli.IDeploymentHistoryCommand, packageHistory: Package[]): void {
    if (command.format === "json") {
        printJson(packageHistory);
    } else if (command.format === "table") {
        printTable(["Label", "Release Time", "App Version", "Mandatory", "Description"], (dataSource: any[]) => {
            packageHistory.forEach((packageObject: Package) => {
                var releaseTime: string = formatDate(packageObject.uploadTime);
                var releaseSource: string;
                if (packageObject.releaseMethod === "Promote") {
                    releaseSource = `Promoted ${ packageObject.originalLabel } from "${ packageObject.originalDeployment }"`;
                } else if (packageObject.releaseMethod === "Rollback") {
                    var labelNumber: number = parseInt(packageObject.label.substring(1));
                    var lastLabel: string = "v" + (labelNumber - 1);
                    releaseSource = `Rolled back ${ lastLabel } to ${ packageObject.originalLabel }`;
                }

                if (releaseSource) {
                    releaseTime += "\n" + chalk.magenta(`(${releaseSource})`).toString();
                }

                dataSource.push([
                    packageObject.label,
                    releaseTime,
                    packageObject.appVersion,
                    packageObject.isMandatory ? "Yes" : "No",
                    packageObject.description ? wordwrap(30)(packageObject.description) : ""
                ]);
            });
        });
    }
}

function getPackageString(packageObject: Package): string {
    if (!packageObject) {
        return "";
    }

    return chalk.green("Label: ") + packageObject.label + "\n" +
        chalk.green("App Version: ") + packageObject.appVersion + "\n" +
        chalk.green("Mandatory: ") + (packageObject.isMandatory ? "Yes" : "No") + "\n" +
        chalk.green("Release Time: ") + formatDate(packageObject.uploadTime) +
        (packageObject.description ? wordwrap(70)("\n" + chalk.green("Description: ") + packageObject.description): "");
}

function printJson(object: any): void {
    log(JSON.stringify(object, /*replacer=*/ null, /*spacing=*/ 2));
}

function printAccessKeys(format: string, keys: AccessKey[]): void {
    if (format === "json") {
        printJson(keys);
    } else if (format === "table") {
        printTable(["Key", "Time Created", "Created From", "Description"], (dataSource: any[]): void => {
            keys.forEach((key: AccessKey): void => {
                dataSource.push([
                    key.name,
                    key.createdTime ? formatDate(key.createdTime) : "",
                    key.createdBy ? key.createdBy : "",
                    key.description ? key.description : ""
                ]);
            });
        });
    }
}

function printTable(columnNames: string[], readData: (dataSource: any[]) => void): void {
    var table = new Table({
        head: columnNames,
        style: { head: ["cyan"] }
    });

    readData(table);

    log(table.toString());
}

function register(command: cli.IRegisterCommand): Promise<void> {
    initiateExternalAuthenticationAsync(command.serverUrl, "register");

    return loginWithAccessTokenInternal(command.serverUrl);
}

function promote(command: cli.IPromoteCommand): Promise<void> {
    var appId: string;
    var sourceDeploymentId: string;
    var destDeploymentId: string;

    return getAppId(command.appName)
        .then((appIdResult: string): Promise<string> => {
            throwForInvalidAppId(appIdResult, command.appName);
            appId = appIdResult;
            return getDeploymentId(appId, command.sourceDeploymentName);
        })
        .then((deploymentId: string): Promise<string> => {
            throwForInvalidDeploymentId(deploymentId, command.sourceDeploymentName, command.appName);
            sourceDeploymentId = deploymentId;
            return getDeploymentId(appId, command.destDeploymentName);
        })
        .then((deploymentId: string): Promise<void> => {
            throwForInvalidDeploymentId(deploymentId, command.destDeploymentName, command.appName);
            destDeploymentId = deploymentId;
            return sdk.promotePackage(appId, sourceDeploymentId, destDeploymentId);
        })
        .then((): void => {
            log("Successfully promoted the \"" + command.sourceDeploymentName + "\" deployment of the \"" + command.appName + "\" app to the \"" + command.destDeploymentName + "\" deployment.");
        });
}

function release(command: cli.IReleaseCommand): Promise<void> {
    if (command.package.search(/\.zip$/i) !== -1) {
        throw new Error("It is unnecessary to package releases in a .zip file. Please specify the path of the desired directory or file directly.");
    } else if (semver.valid(command.appStoreVersion) === null) {
        throw new Error("Please use a semver compliant app store version, for example \"1.0.3\".");
    }

    return getAppId(command.appName)
        .then((appId: string): Promise<void> => {
            throwForInvalidAppId(appId, command.appName);

            return getDeploymentId(appId, command.deploymentName)
                .then((deploymentId: string): Promise<void> => {
                    throwForInvalidDeploymentId(deploymentId, command.deploymentName, command.appName);

                    var filePath: string = command.package;
                    var getPackageFilePromise: Promise<IPackageFile>;
                    var isSingleFilePackage: boolean = true;

                    if (fs.lstatSync(filePath).isDirectory()) {
                        isSingleFilePackage = false;
                        getPackageFilePromise = Promise<IPackageFile>((resolve: (file: IPackageFile) => void, reject: (reason: Error) => void): void => {
                            var directoryPath: string = filePath;

                            recursiveFs.readdirr(directoryPath, (error?: any, directories?: string[], files?: string[]): void => {
                                if (error) {
                                    reject(error);
                                    return;
                                }

                                var baseDirectoryPath = path.dirname(directoryPath);
                                var fileName: string = generateRandomFilename(15) + ".zip";
                                var zipFile = new yazl.ZipFile();
                                var writeStream: fs.WriteStream = fs.createWriteStream(fileName);

                                zipFile.outputStream.pipe(writeStream)
                                    .on("error", (error: Error): void => {
                                        reject(error);
                                    })
                                    .on("close", (): void => {
                                        filePath = path.join(process.cwd(), fileName);

                                        resolve({ isTemporary: true, path: filePath });
                                    });

                                for (var i = 0; i < files.length; ++i) {
                                    var file: string = files[i];
                                    var relativePath: string = path.relative(baseDirectoryPath, file);

                                    // yazl does not like backslash (\) in the metadata path.
                                    relativePath = slash(relativePath);

                                    zipFile.addFile(file, relativePath);
                                }

                                zipFile.end();
                            });
                        });
                    } else {
                        getPackageFilePromise = Q({ isTemporary: false, path: filePath });
                    }

                    var lastTotalProgress = 0;
                    var progressBar = new progress("Upload progress:[:bar] :percent :etas", {
                        complete: "=",
                        incomplete: " ",
                        width: 50,
                        total: 100
                    });

                    var uploadProgress = (currentProgress: number): void => {
                        progressBar.tick(currentProgress - lastTotalProgress);
                        lastTotalProgress = currentProgress;
                    }

                    return getPackageFilePromise
                        .then((file: IPackageFile): Promise<void> => {
                            return sdk.addPackage(appId, deploymentId, file.path, command.description, /*label*/ null, command.appStoreVersion, command.mandatory, uploadProgress)
                                .then((): void => {
                                    log("Successfully released an update containing the \"" + command.package + "\" " + (isSingleFilePackage ? "file" : "directory") + " to the \"" + command.deploymentName + "\" deployment of the \"" + command.appName + "\" app.");

                                    if (file.isTemporary) {
                                        fs.unlinkSync(filePath);
                                    }
                                });
                        });
                });
        });
}

function rollback(command: cli.IRollbackCommand): Promise<void> {
    var appId: string;

    return confirm()
        .then((wasConfirmed: boolean) => {
            if (!wasConfirmed) {
                log("Rollback cancelled.")
                return;
            }

            return getAppId(command.appName)
                .then((appIdResult: string): Promise<string> => {
                    throwForInvalidAppId(appIdResult, command.appName);
                    appId = appIdResult;
                    return getDeploymentId(appId, command.deploymentName);
                })
                .then((deploymentId: string): Promise<void> => {
                    throwForInvalidDeploymentId(deploymentId, command.deploymentName, command.appName);
                    return sdk.rollbackPackage(appId, deploymentId, command.targetRelease || undefined);
                })
                .then((): void => {
                    log("Successfully performed a rollback on the \"" + command.deploymentName + "\" deployment of the \"" + command.appName + "\" app.");
                });
        });
}

function requestAccessToken(): Promise<string> {
    return Promise<string>((resolve, reject, notify): void => {
        prompt.message = "";
        prompt.delimiter = "";

        prompt.start();

        prompt.get({
            properties: {
                response: {
                    description: chalk.cyan("Enter your access token: ")
                }
            }
        }, (err: any, result: any): void => {
            if (err) {
                resolve(null);
            } else {
                resolve(result.response.trim());
            }
        });
    });
}

function serializeConnectionInfo(serverUrl: string, accessTokenOrKey: string): void {
    // The access token should have been validated already (i.e.:  logging in).
    var json: string = tryBase64Decode(accessTokenOrKey);
    var connectionInfo: ILegacyLoginConnectionInfo|ILoginConnectionInfo = tryJSON(json);

    if (connectionInfo) {
        // This is a legacy login format
        connectionInfo.serverUrl = serverUrl;
    } else {
        // This login uses an access key
        connectionInfo = <ILoginConnectionInfo>{ serverUrl: serverUrl, accessKey: accessTokenOrKey };
    }

    json = JSON.stringify(connectionInfo);
    fs.writeFileSync(configFilePath, json, { encoding: "utf8" });

    log("\r\nSuccessfully logged-in. Your session token was written to " + chalk.cyan(configFilePath) + ". You can run the " + chalk.cyan("code-push logout") + " command at any time to delete this file and terminate your session.\r\n");
}

function tryBase64Decode(encoded: string): string {
    try {
        return base64.decode(encoded);
    } catch (ex) {
        return null;
    }
}

function throwForMissingCredentials(accessKeyName: string, providerName: string, providerUniqueId: string): void {
    if (!accessKeyName) throw new Error("Access key is missing.");
    if (!providerName) throw new Error("Provider name is missing.");
    if (!providerUniqueId) throw new Error("Provider unique ID is missing.");
}

function throwForInvalidAccessKeyId(accessKeyId: string, accessKeyName: string): void {
    if (!accessKeyId) {
        throw new Error("Access key \"" + accessKeyName + "\" does not exist.");
    }
}

function throwForInvalidApp(app: App, appName: string): void {
    if (!app) {
        throw new Error("App \"" + appName + "\" does not exist.");
    }
}

function throwForInvalidAppId(appId: string, appName: string): void {
    if (!appId) {
        throw new Error("App \"" + appName + "\" does not exist.");
    }
}

function throwForInvalidDeployment(deployment: Deployment, deploymentName: string, appName: string): void {
    if (!deployment) {
        throw new Error("Deployment \"" + deploymentName + "\" does not exist for app \"" + appName + "\".");
    }
}

function throwForInvalidDeploymentId(deploymentId: string, deploymentName: string, appName: string): void {
    if (!deploymentId) {
        throw new Error("Deployment \"" + deploymentName + "\" does not exist for app \"" + appName + "\".");
    }
}

function throwForInvalidOutputFormat(format: string): void {
    switch (format) {
        case "json":
        case "table":
            break;

        default:
            throw new Error("Invalid format:  " + format + ".");
    }
}
