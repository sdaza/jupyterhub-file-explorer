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
        const healthCheckIntervalMs = config.get<number>('healthCheckInterval', 60000); // Increased to 60 seconds to reduce overhead
        
        if (enableHealthChecks && !healthCheckInterval) {
            healthCheckInterval = setInterval(async () => {
                if (fileExplorerProvider && lastConnection) {
                    try {
                        const isHealthy = await fileExplorerProvider.checkConnectionHealth();
                        if (!isHealthy) {
                            console.log('Health check failed, connection may be lost');
                        }
                    } catch (error) {
                        console.warn('Health check error (non-critical):', error);
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

    // Register all commands in a more efficient way
    const commands = [
        { id: 'jupyterFileExplorer.connectJupyter', handler: async () => {
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
        }},
        { id: 'jupyterFileExplorer.addJupyterConnection', handler: async () => {
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
        }},
        { id: 'jupyterFileExplorer.selectJupyterConnection', handler: async () => {
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
        }},
        { id: 'jupyterFileExplorer.removeJupyterConnection', handler: async () => {
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
        }},
        { id: 'jupyterFileExplorer.disconnectJupyter', handler: disconnectFromJupyter },
        { id: 'jupyterFileExplorer.refreshJupyterExplorer', handler: () => fileExplorerProvider.refresh() },
        { id: 'jupyterFileExplorer.newFile', handler: (item?: FileItem) => fileExplorerProvider.newFile(item) },
        { id: 'jupyterFileExplorer.newFolder', handler: (item?: FileItem) => fileExplorerProvider.newFolder(item) },
        { id: 'jupyterFileExplorer.newFileInRoot', handler: () => fileExplorerProvider.newFileInRoot() },
        { id: 'jupyterFileExplorer.newFolderInRoot', handler: () => fileExplorerProvider.newFolderInRoot() },
        { id: 'jupyterFileExplorer.uploadFile', handler: (item?: FileItem) => fileExplorerProvider.uploadFile(item) },
        { id: 'jupyterFileExplorer.uploadFolder', handler: (item?: FileItem) => fileExplorerProvider.uploadFolder(item) },
        { id: 'jupyterFileExplorer.downloadFile', handler: (item: FileItem) => fileExplorerProvider.downloadFile(item) },
        { id: 'jupyterFileExplorer.renameFile', handler: (item: FileItem) => fileExplorerProvider.renameFile(item) },
        { id: 'jupyterFileExplorer.deleteFile', handler: (item: FileItem) => fileExplorerProvider.deleteFile(item) },
        { id: 'jupyterFileExplorer.forceDeleteFile', handler: (item: FileItem) => fileExplorerProvider.forceDeleteFile(item) },
        { id: 'jupyterFileExplorer.openFile', handler: (filePath: string) => fileExplorerProvider.openFile(filePath) }
    ];

    // Register all commands and collect disposables
    const commandDisposables = commands.map(cmd => 
        vscode.commands.registerCommand(cmd.id, cmd.handler)
    );

    // Register the FileSystemProvider
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('jupyter-remote', fileExplorerProvider, { 
        isCaseSensitive: true
    }));

    context.subscriptions.push(
        ...commandDisposables
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
