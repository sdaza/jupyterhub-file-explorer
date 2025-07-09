import * as vscode from 'vscode';
import { FileExplorerProvider, JupyterContentProvider, FileItem } from './FileExplorer';

interface Connection {
    name: string;
    url: string;
    token: string;
    remotePath: string;
}

// Module-level variables for cleanup
let fileExplorerProvider: FileExplorerProvider;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnectAttempts = 0;
let lastConnection: Connection | undefined;
let healthCheckInterval: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    fileExplorerProvider = new FileExplorerProvider();
    const jupyterContentProvider = new JupyterContentProvider(fileExplorerProvider);

    const treeView = vscode.window.createTreeView('jupyterFileExplorer', { 
        treeDataProvider: fileExplorerProvider,
        dragAndDropController: fileExplorerProvider
    });

    // Initialize context for extension
    vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', false);

    // Listen for connection loss events
    fileExplorerProvider.onConnectionLost(() => {
        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        const autoReconnect = config.get<boolean>('autoReconnect', true);
        
        if (autoReconnect && lastConnection) {
            console.log('Connection lost event received, initiating auto-reconnect...');
            connectToJupyter(lastConnection);
        }
    });

    const startHealthChecks = () => {
        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        const enableHealthChecks = config.get<boolean>('enableHealthChecks', true);
        const healthCheckIntervalMs = config.get<number>('healthCheckInterval', 30000); // 30 seconds
        
        if (enableHealthChecks && !healthCheckInterval) {
            healthCheckInterval = setInterval(async () => {
                if (fileExplorerProvider && lastConnection) {
                    const isHealthy = await fileExplorerProvider.checkConnectionHealth();
                    if (!isHealthy) {
                        console.log('Health check failed, connection may be lost');
                    }
                }
            }, healthCheckIntervalMs);
        }
    };

    // Start health checks
    startHealthChecks();

    const connectToJupyter = async (connection: Connection) => {
        try {
            await fileExplorerProvider.setConnection(connection.url, connection.token, connection.remotePath || '/', connection.name);
            const axiosInstance = fileExplorerProvider.getAxiosInstance();
            if (axiosInstance) {
                vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', true);
                vscode.window.showInformationMessage(`Connected to ${connection.name}.`);
                treeView.title = connection.name;
                
                // Store successful connection for auto-reconnect and next startup
                lastConnection = connection;
                reconnectAttempts = 0;
                
                // Save last connection for auto-connect on startup
                const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
                await config.update('lastConnection', connection, vscode.ConfigurationTarget.Global);
                
                // Clear any existing reconnect timer
                if (reconnectTimer) {
                    clearTimeout(reconnectTimer);
                    reconnectTimer = undefined;
                }
            } else {
                throw new Error('Failed to create Axios instance.');
            }
        } catch (error) {
            vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', false);
            const errorMessage = `Failed to connect to Jupyter Server: ${error}`;
            console.error(errorMessage);
            
            // Check if auto-reconnect is enabled and we have a connection to retry
            const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
            const autoReconnect = config.get<boolean>('autoReconnect', true);
            const maxAttempts = config.get<number>('maxReconnectAttempts', 3);
            
            if (autoReconnect && lastConnection && reconnectAttempts < maxAttempts) {
                reconnectAttempts++;
                // Exponential backoff: 5s, 10s, 20s for attempts 1, 2, 3
                const baseInterval = config.get<number>('reconnectInterval', 5000);
                const backoffInterval = baseInterval * Math.pow(2, reconnectAttempts - 1);
                
                vscode.window.showWarningMessage(
                    `Connection lost. Attempting to reconnect in ${backoffInterval/1000}s (${reconnectAttempts}/${maxAttempts})...`
                );
                
                reconnectTimer = setTimeout(() => {
                    connectToJupyter(lastConnection!);
                }, backoffInterval);
            } else {
                vscode.window.showErrorMessage(errorMessage);
                if (autoReconnect && reconnectAttempts >= maxAttempts) {
                    vscode.window.showErrorMessage(`Auto-reconnect failed after ${maxAttempts} attempts.`);
                    reconnectAttempts = 0;
                }
            }
        }
    };

    const disconnectFromJupyter = () => {
        fileExplorerProvider.disconnect();
        vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', false);
        vscode.window.showInformationMessage('Disconnected from Jupyter Server.');
        treeView.title = 'Files';
        
        // Clear reconnect state
        lastConnection = undefined;
        reconnectAttempts = 0;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = undefined;
        }
    };

    let connectDisposable = vscode.commands.registerCommand('jupyterFileExplorer.connectJupyter', async () => {
        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        const connections = config.get<Connection[]>('connections') || [];

        if (connections.length === 0) {
            vscode.window.showInformationMessage('No saved connections. Please add a new connection.');
            await vscode.commands.executeCommand('jupyterFileExplorer.addJupyterConnection');
            return;
        }

        const selected = await vscode.window.showQuickPick(connections.map(c => c.name), {
            placeHolder: 'Select a Jupyter Server to connect to'
        });

        if (selected) {
            const connection = connections.find(c => c.name === selected);
            if (connection) {
                await connectToJupyter(connection);
            }
        }
    });

    let addConnectionDisposable = vscode.commands.registerCommand('jupyterFileExplorer.addJupyterConnection', async () => {
        const name = await vscode.window.showInputBox({ prompt: 'Enter a name for this connection' });
        if (!name) return;

        const url = await vscode.window.showInputBox({ prompt: 'Enter Jupyter Server URL', ignoreFocusOut: true });
        if (!url) return;

        const token = await vscode.window.showInputBox({ prompt: 'Enter Jupyter Token', password: true, ignoreFocusOut: true });
        if (!token) return;

        const remotePath = await vscode.window.showInputBox({ prompt: 'Enter Remote Path', value: '/', ignoreFocusOut: true });

        const newConnection: Connection = { name, url, token, remotePath: remotePath || '/' };

        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        const connections = config.get<Connection[]>('connections') || [];
        connections.push(newConnection);
        await config.update('connections', connections, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage(`Connection '${name}' saved.`);
    });

    let selectConnectionDisposable = vscode.commands.registerCommand('jupyterFileExplorer.selectJupyterConnection', async () => {
        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        const connections = config.get<Connection[]>('connections') || [];

        if (connections.length === 0) {
            vscode.window.showInformationMessage('No saved connections found.');
            return;
        }

        const selected = await vscode.window.showQuickPick(connections.map(c => c.name), {
            placeHolder: 'Select a connection'
        });

        if (selected) {
            const connection = connections.find(c => c.name === selected);
            if (connection) {
                await connectToJupyter(connection);
            }
        }
    });

    let removeConnectionDisposable = vscode.commands.registerCommand('jupyterFileExplorer.removeJupyterConnection', async () => {
        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        const connections = config.get<Connection[]>('connections') || [];

        if (connections.length === 0) {
            vscode.window.showInformationMessage('No saved connections to remove.');
            return;
        }

        const selected = await vscode.window.showQuickPick(connections.map(c => c.name), {
            placeHolder: 'Select a connection to remove'
        });

        if (selected) {
            const updatedConnections = connections.filter(c => c.name !== selected);
            await config.update('connections', updatedConnections, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Connection '${selected}' removed.`);
        }
    });

    let disconnectDisposable = vscode.commands.registerCommand('jupyterFileExplorer.disconnectJupyter', disconnectFromJupyter);

    let refreshDisposable = vscode.commands.registerCommand('jupyterFileExplorer.refreshJupyterExplorer', () => {
        fileExplorerProvider.refresh();
    });

    let newFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.newFile', (item?: FileItem) => {
        fileExplorerProvider.newFile(item);
    });

    let newFolderDisposable = vscode.commands.registerCommand('jupyterFileExplorer.newFolder', (item?: FileItem) => {
        fileExplorerProvider.newFolder(item);
    });

    let newFileInRootDisposable = vscode.commands.registerCommand('jupyterFileExplorer.newFileInRoot', () => {
        fileExplorerProvider.newFileInRoot();
    });

    let newFolderInRootDisposable = vscode.commands.registerCommand('jupyterFileExplorer.newFolderInRoot', () => {
        fileExplorerProvider.newFolderInRoot();
    });

    let uploadFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.uploadFile', (item?: FileItem) => {
        fileExplorerProvider.uploadFile(item);
    });

    let uploadFolderDisposable = vscode.commands.registerCommand('jupyterFileExplorer.uploadFolder', (item?: FileItem) => {
        fileExplorerProvider.uploadFolder(item);
    });

    let downloadFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.downloadFile', (item: FileItem) => {
        fileExplorerProvider.downloadFile(item);
    });

    let renameFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.renameFile', (item: FileItem) => {
        fileExplorerProvider.renameFile(item);
    });

    let deleteFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.deleteFile', (item: FileItem) => {
        fileExplorerProvider.deleteFile(item);
    });

    let forceDeleteFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.forceDeleteFile', (item: FileItem) => {
        fileExplorerProvider.forceDeleteFile(item);
    });

    let openFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.openFile', (filePath: string) => {
        fileExplorerProvider.openFile(filePath);
    });

    // Register the FileSystemProvider
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('jupyter-remote', fileExplorerProvider, { 
        isCaseSensitive: true
    }));

    context.subscriptions.push(
        connectDisposable,
        addConnectionDisposable,
        selectConnectionDisposable,
        removeConnectionDisposable,
        disconnectDisposable,
        refreshDisposable,
        newFileDisposable,
        newFolderDisposable,
        newFileInRootDisposable,
        newFolderInRootDisposable,
        uploadFileDisposable,
        uploadFolderDisposable,
        downloadFileDisposable,
        renameFileDisposable,
        deleteFileDisposable,
        forceDeleteFileDisposable,
        openFileDisposable
    );
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('jupyter-remote', jupyterContentProvider));

    // Set initial context
    vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', false);

    // Auto-connect on startup if enabled
    const autoConnectOnStartup = async () => {
        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        const autoConnect = config.get<boolean>('autoConnect', false);
        
        if (autoConnect) {
            const savedLastConnection = config.get<Connection>('lastConnection');
            
            if (savedLastConnection && savedLastConnection.name && savedLastConnection.url && savedLastConnection.token) {
                console.log(`Auto-connecting to ${savedLastConnection.name}...`);
                await connectToJupyter(savedLastConnection);
            }
        }
    };

    // Run auto-connect after a short delay to ensure extension is fully loaded
    setTimeout(autoConnectOnStartup, 1000);
}

export function deactivate() {
    console.log('JupyterHub File Explorer: Extension deactivating...');
    
    // Clear any pending reconnect timers
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }
    
    // Clear health check interval
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = undefined;
    }
    
    // Perform graceful shutdown to clean up resources
    if (fileExplorerProvider) {
        fileExplorerProvider.gracefulShutdown();
    }
    
    // Reset module variables
    reconnectAttempts = 0;
    lastConnection = undefined;
    
    console.log('JupyterHub File Explorer: Extension deactivated cleanly');
}
