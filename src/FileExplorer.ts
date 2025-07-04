import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';

export class FileExplorerProvider implements vscode.TreeDataProvider<FileItem>, vscode.FileSystemProvider {
    private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null> = new vscode.EventEmitter<FileItem | undefined | null>();
    readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | null> = this._onDidChangeTreeData.event;

    private jupyterServerUrl: string = '';
    private jupyterToken: string = '';
    private remotePath: string = '/';
    private axiosInstance: AxiosInstance | null = null;

    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    constructor() {
        // Initialize with default values or prompt the user
    }

    async setConnection(url: string, token: string, remotePath: string) {
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
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
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

    async getChildren(element?: FileItem): Promise<FileItem[]> {
        if (!this.axiosInstance) {
            vscode.window.showErrorMessage('Not connected to Jupyter Server.');
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
        if (!this.axiosInstance) {
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
        if (!this.axiosInstance) {
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
        if (!this.axiosInstance) {
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

    public getAxiosInstance(): AxiosInstance | null {
        return this.axiosInstance;
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        return {
            type: vscode.FileType.File,
            ctime: Date.now(),
            mtime: Date.now(),
            size: 0
        };
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
        throw vscode.FileSystemError.NoPermissions();
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        if (!this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
        const path = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        const apiUrl = `api/contents/${path}`;
        try {
            await this.axiosInstance.put(apiUrl, { type: 'directory', content: null });
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create directory: ${error}`);
            throw vscode.FileSystemError.Unavailable(`Failed to create directory: ${error}`);
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const content = await this.fetchFileContent(uri.path.slice(1));
        return Buffer.from(content);
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Promise<void> {
        if (!this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
        const path = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        await this.saveFileToJupyter(path, content.toString());
        this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        if (!this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
        const path = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        const apiUrl = `api/contents/${path}`;
        try {
            await this.axiosInstance.delete(apiUrl);
            this.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete: ${error}`);
            throw vscode.FileSystemError.Unavailable(`Failed to delete: ${error}`);
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }): Promise<void> {
        if (!this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
        const oldPath = oldUri.path.startsWith('/') ? oldUri.path.substring(1) : oldUri.path;
        const newPath = newUri.path.startsWith('/') ? newUri.path.substring(1) : newUri.path;
        const apiUrl = `api/contents/${oldPath}`;
        try {
            await this.axiosInstance.patch(apiUrl, { path: newPath });
            this.refresh();
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
