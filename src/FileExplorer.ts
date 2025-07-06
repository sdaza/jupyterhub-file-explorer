import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export class FileExplorerProvider implements vscode.TreeDataProvider<FileItem>, vscode.FileSystemProvider, vscode.TreeDragAndDropController<FileItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null> = new vscode.EventEmitter<FileItem | undefined | null>();
    readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | null> = this._onDidChangeTreeData.event;

    // Drag and drop support
    readonly dropMimeTypes = [
        'text/uri-list',
        'application/vnd.code.tree.jupyterFileExplorer'
    ];
    readonly dragMimeTypes = ['application/vnd.code.tree.jupyterFileExplorer'];

    private jupyterServerUrl: string = '';
    private jupyterToken: string = '';
    private remotePath: string = '/';
    private axiosInstance: AxiosInstance | null = null;
    private isConnected: boolean = false;

    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    constructor() {
        // Initialize with default values or prompt the user
    }

    async setConnection(url: string, token: string, remotePath: string, connectionName?: string) {
        let serverUrl = url.endsWith('/') ? url : url + '/';
        
        // Clean up remote path
        let finalRemotePath = remotePath.replace(/^\.\//, '');
        if (finalRemotePath.startsWith('/')) {
            finalRemotePath = finalRemotePath.substring(1);
        }
        if (finalRemotePath.endsWith('/')) {
            finalRemotePath = finalRemotePath.slice(0, -1);
        }

        // For JupyterHub, the user-specific path can be provided in remotePath
        // and should be appended to the server URL to form the base URL for API calls.
        if (finalRemotePath) {
            serverUrl = new URL(finalRemotePath, serverUrl).href;
        }
        
        this.jupyterServerUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        this.jupyterToken = token;
        // The remote path is now part of the base URL, so we browse from its root.
        this.remotePath = '/'; 
        this.setupAxiosInstance();
        this.isConnected = true;
        this.refresh();
    }

    disconnect() {
        this.axiosInstance = null;
        this.isConnected = false;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(null);
    }

    getTreeItem(element: FileItem): vscode.TreeItem {
        return element;
    }

    public setupAxiosInstance() {
        this.axiosInstance = axios.create({
            baseURL: this.jupyterServerUrl,
            headers: {
                'Authorization': `token ${this.jupyterToken}`
            }
        });
    }

    public getAxiosInstance(): AxiosInstance | null {
        return this.axiosInstance;
    }

    async getChildren(element?: FileItem): Promise<FileItem[]> {
        if (!this.isConnected || !this.axiosInstance) {
            return [];
        }

        const path = element ? element.uri : this.remotePath;
        const finalPath = path.startsWith('/') ? path.substring(1) : path;
        // Add a cache-busting parameter to the URL
        const apiUrl = `api/contents/${finalPath}?t=${new Date().getTime()}`;

        try {
            const response = await this.axiosInstance.get(apiUrl);
            return response.data.content.map((item: any) => new FileItem(item.name, item.type === 'directory', item.path));
        } catch (error) {
            let errorMessage = `Failed to fetch file list from Jupyter Server. API URL: ${apiUrl}`;
            if (axios.isAxiosError(error)) {
                errorMessage += ` Error: ${error.message}`;
                if (error.response) {
                    errorMessage += ` Status: ${error.response.status}`;
                    errorMessage += ` Data: ${JSON.stringify(error.response.data)}`;
                }
            } else {
                errorMessage += ` ${error}`;
            }
            console.error(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
            return [];
        }
    }

    async openFile(filePath: string) {
        if (!this.isConnected || !this.axiosInstance) {
            vscode.window.showErrorMessage('Not connected to Jupyter Server.');
            return;
        }

        try {
            const fileName = filePath.split('/').pop() || 'untitled';
            const uri = vscode.Uri.parse(`jupyter-remote:/${filePath}`);

            // Open the document with the custom URI
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);

            // Set the file name and language
            await vscode.languages.setTextDocumentLanguage(document, this.getLanguageId(fileName));

        } catch (error) {
            vscode.window.showErrorMessage('Failed to open file.');
        }
    }

    private async fetchFileContent(filePath: string): Promise<string> {
        if (!this.isConnected || !this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server.');
        }

        const apiUrl = `api/contents/${filePath}`;
        try {
            const response = await this.axiosInstance.get(apiUrl);
            return response.data.content;
        } catch (error) {
            console.error('Failed to fetch file content:', error);
            throw new Error('Failed to fetch file content from Jupyter Server.');
        }
    }

    private getLanguageId(fileName: string): string {
        const extension = fileName.split('.').pop()?.toLowerCase();
        switch (extension) {
            case 'py':
                return 'python';
            case 'js':
                return 'javascript';
            case 'ts':
                return 'typescript';
            // Add more mappings as needed
            default:
                return 'plaintext';
        }
    }

    public async saveFileToJupyter(filePath: string, content: string) {
        if (!this.isConnected || !this.axiosInstance) {
            vscode.window.showErrorMessage('Not connected to Jupyter Server.');
            return;
        }

        try {
            const apiUrl = `api/contents/${filePath}`;
            await this.axiosInstance.put(apiUrl, {
                content,
                type: 'file',
                format: 'text'
            });
            vscode.window.showInformationMessage('File saved to Jupyter Server.');
        } catch (error) {
            vscode.window.showErrorMessage('Failed to save file to Jupyter Server.');
        }
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        // For now, we don't support watching files.
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        // This is a simplified stat. A real implementation would query the server.
        return {
            type: vscode.FileType.File,
            ctime: Date.now(),
            mtime: Date.now(),
            size: 0
        };
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
        // This method should be implemented to read directories for the FileSystemProvider.
        throw vscode.FileSystemError.NoPermissions();
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        if (!this.isConnected || !this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server.');
        }
        const path = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        const apiUrl = `api/contents/${path}`;
        try {
            await this.axiosInstance.put(apiUrl, { type: 'directory', content: null });
            const parentUri = vscode.Uri.parse(`jupyter-remote:${this.extractParentPath(uri.path)}`);
            this._emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: parentUri }]);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create directory: ${error}`);
            throw vscode.FileSystemError.Unavailable(`Failed to create directory: ${error}`);
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        if (!this.isConnected || !this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server.');
        }
        const content = await this.fetchFileContent(uri.path.slice(1));
        return Buffer.from(content);
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
        if (!this.isConnected || !this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
        const path = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        await this.saveFileToJupyter(path, content.toString());
        const parentUri = vscode.Uri.parse(`jupyter-remote:${this.extractParentPath(uri.path)}`);
        this._emitter.fire([{ type: options.create ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri }]);
        this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: parentUri }]);
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        if (!this.isConnected || !this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
    
        const itemPath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        
        const apiUrl = `api/contents/${itemPath}`;
        try {
            await this.axiosInstance.delete(apiUrl);
            const parentUri = vscode.Uri.parse(`jupyter-remote:${this.extractParentPath(uri.path)}`);
            this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: parentUri }]);
    
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete: ${error}`);
            throw vscode.FileSystemError.Unavailable(`Failed to delete: ${error}`);
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
        if (!this.isConnected || !this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
        const oldPath = oldUri.path.startsWith('/') ? oldUri.path.substring(1) : oldUri.path;
        const newPath = newUri.path.startsWith('/') ? newUri.path.substring(1) : newUri.path;
        const apiUrl = `api/contents/${oldPath}`;
        try {
            await this.axiosInstance.patch(apiUrl, { path: newPath });
            const oldParentUri = vscode.Uri.parse(`jupyter-remote:${this.extractParentPath(oldUri.path)}`);
            const newParentUri = vscode.Uri.parse(`jupyter-remote:${this.extractParentPath(newUri.path)}`);
            this._emitter.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri }
            ]);
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: oldParentUri }]);
            if (oldParentUri.path !== newParentUri.path) {
                this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: newParentUri }]);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to rename: ${error}`);
            throw vscode.FileSystemError.Unavailable(`Failed to rename: ${error}`);
        }
    }

    async newFile(item?: FileItem): Promise<void> {
        const parentPath = item ? (item.collapsible ? item.uri : this.extractParentPath(item.uri)) : this.remotePath;
        const fileName = await vscode.window.showInputBox({ prompt: 'Enter file name', ignoreFocusOut: true });
        if (fileName) {
            const newFilePath = `${parentPath}/${fileName}`.replace('//', '/');
            const uri = vscode.Uri.parse(`jupyter-remote:${newFilePath}`);
            await this.writeFile(uri, new Uint8Array(Buffer.from('')), { create: true, overwrite: false });
            this.refresh();
        }
    }

    async newFolder(item?: FileItem): Promise<void> {
        const parentPath = item ? (item.collapsible ? item.uri : this.extractParentPath(item.uri)) : this.remotePath;
        const folderName = await vscode.window.showInputBox({ prompt: 'Enter folder name', ignoreFocusOut: true });
        if (folderName) {
            const newFolderPath = `${parentPath}/${folderName}`.replace('//', '/');
            const uri = vscode.Uri.parse(`jupyter-remote:${newFolderPath}`);
            await this.createDirectory(uri);
            this.refresh();
        }
    }

    async renameFile(item: FileItem): Promise<void> {
        const oldPath = item.uri;
        const oldName = item.label as string;
        const newName = await vscode.window.showInputBox({ prompt: 'Enter new name', value: oldName, ignoreFocusOut: true });
        if (newName && newName !== oldName) {
            const newPath = this.extractParentPath(oldPath) + '/' + newName;
            const oldUri = vscode.Uri.parse(`jupyter-remote:${oldPath}`);
            const newUri = vscode.Uri.parse(`jupyter-remote:${newPath}`);
            await this.rename(oldUri, newUri, { overwrite: false });
            this.refresh();
        }
    }

    async deleteFile(item: FileItem): Promise<void> {
        const result = await vscode.window.showWarningMessage(`Are you sure you want to delete ${item.label}?`, { modal: true }, 'Delete');
        if (result === 'Delete') {
            const uri = vscode.Uri.parse(`jupyter-remote:${item.uri}`);
            await this.delete(uri, { recursive: true });
            this.refresh();
        }
    }

    private extractParentPath(path: string): string {
        const parts = path.split('/');
        parts.pop();
        return parts.join('/') || '/';
    }

    // Missing methods needed by extension commands
    async newFileInRoot(): Promise<void> {
        await this.newFile();
    }

    async newFolderInRoot(): Promise<void> {
        await this.newFolder();
    }

    async uploadFile(targetDirectory?: FileItem): Promise<void> {
        vscode.window.showInformationMessage('Upload file functionality not implemented in base version.');
    }

    async uploadFolder(targetDirectory?: FileItem): Promise<void> {
        vscode.window.showInformationMessage('Upload folder functionality not implemented in base version.');
    }

    async downloadFile(item: FileItem): Promise<void> {
        vscode.window.showInformationMessage('Download file functionality not implemented in base version.');
    }

    // Drag and drop support methods
    async handleDrag(source: readonly FileItem[], dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        console.log('handleDrag called with', source.length, 'items');
        dataTransfer.set('application/vnd.code.tree.jupyterFileExplorer', new vscode.DataTransferItem(source));
    }

    async handleDrop(target: FileItem | undefined, dataTransfer: vscode.DataTransfer, token: vscode.CancellationToken): Promise<void> {
        console.log('handleDrop called with target:', target?.label);
        
        // Check for internal tree item moves
        const internalTransfer = dataTransfer.get('application/vnd.code.tree.jupyterFileExplorer');
        if (internalTransfer) {
            await this.handleInternalMove(internalTransfer, target);
            return;
        }
        
        vscode.window.showInformationMessage('External file upload via drag & drop is not implemented in this base version.');
    }

    private async handleInternalMove(transferItem: vscode.DataTransferItem, target: FileItem | undefined): Promise<void> {
        try {
            console.log('handleInternalMove called');
            
            const sourceItems = transferItem.value as FileItem[];
            if (!sourceItems || sourceItems.length === 0) {
                console.log('No source items found');
                return;
            }

            // Determine target directory
            let targetPath: string;
            if (target) {
                targetPath = target.collapsible ? target.uri : this.extractParentPath(target.uri);
            } else {
                targetPath = this.remotePath;
            }

            console.log(`Moving ${sourceItems.length} items to: ${targetPath}`);

            let successCount = 0;
            let errorCount = 0;

            for (const sourceItem of sourceItems) {
                try {
                    const sourceParent = this.extractParentPath(sourceItem.uri);
                    
                    if (sourceParent === targetPath) {
                        console.log(`Skipping ${sourceItem.label} - already in target directory`);
                        continue;
                    }

                    if (sourceItem.collapsible && targetPath.startsWith(sourceItem.uri)) {
                        vscode.window.showErrorMessage(`Cannot move directory "${sourceItem.label}" into itself.`);
                        errorCount++;
                        continue;
                    }

                    const newPath = `${targetPath}/${sourceItem.label}`.replace('//', '/');
                    console.log(`Moving ${sourceItem.uri} to ${newPath}`);
                    
                    await this.moveItem(sourceItem.uri, newPath);
                    successCount++;
                    
                } catch (error) {
                    console.error(`Failed to move ${sourceItem.label}:`, error);
                    vscode.window.showErrorMessage(`Failed to move ${sourceItem.label}: ${error}`);
                    errorCount++;
                }
            }

            this.refresh();

            if (successCount > 0) {
                vscode.window.showInformationMessage(`Successfully moved ${successCount} item(s).`);
            }
            if (errorCount > 0) {
                vscode.window.showWarningMessage(`Failed to move ${errorCount} item(s). Check the output for details.`);
            }

        } catch (error) {
            console.error('Failed to handle internal move:', error);
            vscode.window.showErrorMessage(`Failed to move items: ${error}`);
        }
    }

    private async moveItem(sourcePath: string, targetPath: string): Promise<void> {
        if (!this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server');
        }

        try {
            console.log(`Attempting to move: ${sourcePath} -> ${targetPath}`);
            
            // Jupyter Server API expects paths without leading slashes for the API endpoint
            // but the source path in the URL should match exactly how it's stored
            const sourcePathClean = sourcePath.startsWith('/') ? sourcePath.substring(1) : sourcePath;
            const targetPathClean = targetPath.startsWith('/') ? targetPath.substring(1) : targetPath;
            
            const apiUrl = `api/contents/${sourcePathClean}`;
            
            console.log(`API URL: ${this.jupyterServerUrl}${apiUrl}`);
            console.log(`Request body path: ${targetPathClean}`);
            
            const response = await this.axiosInstance.patch(apiUrl, {
                path: targetPathClean
            });

            console.log(`Successfully moved ${sourcePath} to ${targetPath}`, response.status);
            
        } catch (error: any) {
            console.error('Move operation failed:', error);
            
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
                console.error('Request URL:', error.config?.url);
                console.error('Request data:', error.config?.data);
                
                // More specific error handling
                if (error.response.status === 404) {
                    throw new Error(`File not found: The source file "${sourcePath}" does not exist on the server.`);
                } else if (error.response.status === 409) {
                    throw new Error(`Conflict: A file already exists at "${targetPath}".`);
                } else {
                    throw new Error(`Move failed: ${error.response.status} - ${error.response.data?.message || 'Unknown server error'}`);
                }
            } else {
                throw new Error(`Move failed: ${error.message}`);
            }
        }
    }
}

export class FileItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsible: boolean,
        public readonly uri: string
    ) {
        super(label, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        this.tooltip = this.label;
        this.description = this.uri;
        this.contextValue = collapsible ? 'directory' : 'file';

        if (!collapsible) {
            this.command = {
                command: 'jupyterFileExplorer.openFile',
                title: 'Open File',
                arguments: [this.uri]
            };
        }
    }
}

export class JupyterContentProvider implements vscode.TextDocumentContentProvider {
    private axiosInstance: AxiosInstance | null = null;

    constructor(private fileExplorerProvider: FileExplorerProvider) {}

    setAxiosInstance(axiosInstance: AxiosInstance) {
        this.axiosInstance = axiosInstance;
    }

    async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
        if (!this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server.');
        }

        const filePath = uri.path;
        const apiUrl = `api/contents${filePath}`;

        try {
            const response = await this.axiosInstance.get(apiUrl);
            return response.data.content;
        } catch (error) {
            console.error('Failed to fetch file content:', error);
            throw new Error('Failed to fetch file content from Jupyter Server.');
        }
    }
}
