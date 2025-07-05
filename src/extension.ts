import * as vscode from 'vscode';
import { FileExplorerProvider, JupyterContentProvider, FileItem } from './FileExplorer';

interface Connection {
    name: string;
    url: string;
    token: string;
    remotePath: string;
}

export function activate(context: vscode.ExtensionContext) {
    const fileExplorerProvider = new FileExplorerProvider();
    const jupyterContentProvider = new JupyterContentProvider(fileExplorerProvider);

    const treeView = vscode.window.createTreeView('jupyterFileExplorer', { treeDataProvider: fileExplorerProvider });

    const connectToJupyter = async (connection: Connection) => {
        try {
            await fileExplorerProvider.setConnection(connection.url, connection.token, connection.remotePath || '/');
            const axiosInstance = fileExplorerProvider.getAxiosInstance();
            if (axiosInstance) {
                jupyterContentProvider.setAxiosInstance(axiosInstance);
                vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', true);
                vscode.window.showInformationMessage(`Connected to ${connection.name}.`);
                treeView.title = connection.name;
            } else {
                throw new Error('Failed to create Axios instance.');
            }
        } catch (error) {
            vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', false);
            vscode.window.showErrorMessage(`Failed to connect to Jupyter Server: ${error}`);
        }
    };

    const disconnectFromJupyter = () => {
        fileExplorerProvider.disconnect();
        vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', false);
        vscode.window.showInformationMessage('Disconnected from Jupyter Server.');
        treeView.title = 'Files';
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

    let newFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.newFile', (item: FileItem) => {
        fileExplorerProvider.newFile(item);
    });

    let newFolderDisposable = vscode.commands.registerCommand('jupyterFileExplorer.newFolder', (item: FileItem) => {
        fileExplorerProvider.newFolder(item);
    });

    let renameFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.renameFile', (item: FileItem) => {
        fileExplorerProvider.renameFile(item);
    });

    let deleteFileDisposable = vscode.commands.registerCommand('jupyterFileExplorer.deleteFile', (item: FileItem) => {
        fileExplorerProvider.deleteFile(item);
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
        renameFileDisposable,
        deleteFileDisposable,
        openFileDisposable
    );
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('jupyter-remote', jupyterContentProvider));

    // Set initial context
    vscode.commands.executeCommand('setContext', 'jupyterFileExplorer.connected', false);
}

export function deactivate() {}
