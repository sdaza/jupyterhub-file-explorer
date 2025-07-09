import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export class FileExplorerProvider implements vscode.TreeDataProvider<FileItem>, vscode.FileSystemProvider, vscode.TreeDragAndDropController<FileItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<FileItem | undefined | null> = new vscode.EventEmitter<FileItem | undefined | null>();
    readonly onDidChangeTreeData: vscode.Event<FileItem | undefined | null> = this._onDidChangeTreeData.event;

    // Connection lost event
    private _onConnectionLost: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onConnectionLost: vscode.Event<void> = this._onConnectionLost.event;

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

    // Rate limiting and caching
    private lastRequestTime: number = 0;
    private requestDelay: number = 100; // Minimum 100ms between requests
    private cache = new Map<string, { data: any; timestamp: number }>();
    private cacheTimeout: number = 5000; // Cache for 5 seconds
    private pendingRequests = new Map<string, Promise<any>>();

    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    constructor() {
        // Initialize with default values or prompt the user
        this.updateConfigSettings();
    }

    private updateConfigSettings(): void {
        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        this.requestDelay = config.get<number>('requestDelay', 100);
        this.cacheTimeout = config.get<number>('cacheTimeout', 5000);
        
        // Clear cache if settings changed significantly
        const maxCacheSize = config.get<number>('maxCacheSize', 100);
        if (this.cache.size > maxCacheSize) {
            this.clearCache();
        }
    }

    private getConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('jupyterFileExplorer');
    }

    private clearCache(): void {
        this.cache.clear();
        this.pendingRequests.clear();
    }

    private invalidateCacheForPath(path: string): void {
        // Invalidate cache entries that might be affected by changes to this path
        const keysToDelete: string[] = [];
        for (const [key] of this.cache) {
            if (key.includes(path) || path.includes(key.split(':')[1] || '')) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => this.cache.delete(key));
    }

    async setConnection(url: string, token: string, remotePath: string, connectionName?: string) {
        try {
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
            
            // Clear any existing connection state
            this.clearCache();
            this.pendingRequests.clear();
            
            this.setupAxiosInstance();
            
            // Validate connection by checking if axios instance was created
            if (!this.axiosInstance) {
                throw new Error('Failed to create axios instance');
            }
            
            this.isConnected = true;
            this.refresh();
            
            console.log(`Successfully connected to ${this.jupyterServerUrl}`);
        } catch (error) {
            console.error('Failed to set connection:', error);
            this.isConnected = false;
            this.axiosInstance = null;
            throw error;
        }
    }

    disconnect() {
        console.log('Disconnecting from Jupyter server...');
        
        // Clear all pending requests to prevent ongoing server hits
        this.pendingRequests.clear();
        
        // Clear all timers and cleanup
        if (this.axiosInstance) {
            // Cancel any pending axios requests
            this.axiosInstance.interceptors.request.clear();
            this.axiosInstance.interceptors.response.clear();
        }
        
        this.axiosInstance = null;
        this.isConnected = false;
        this.clearCache(); // Clear all cache on disconnect
        
        // Reset rate limiting
        this.lastRequestTime = 0;
        this.requestDelay = 100; // Reset to default
        
        this.refresh();
        console.log('Disconnected from Jupyter server');
    }

    gracefulShutdown(): void {
        console.log('JupyterHub File Explorer: Performing graceful shutdown...');
        
        // Stop any ongoing operations
        this.pendingRequests.clear();
        
        // Clear all caches to free memory
        this.clearCache();
        
        // Disconnect cleanly
        this.disconnect();
        
        console.log('JupyterHub File Explorer: Graceful shutdown completed');
    }

    refresh(): void {
        this.clearCache(); // Clear cache on manual refresh
        this._onDidChangeTreeData.fire(null);
    }



    getTreeItem(element: FileItem): vscode.TreeItem {
        // Try to enhance metadata for files if not already available
        if (!element.fileSize && !element.collapsible) {
            this.getFileInfo(element.uri).then(info => {
                if (info) {
                    element.updateMetadata(info);
                    this._onDidChangeTreeData.fire(element);
                }
            }).catch(() => {
                // Silently ignore errors for metadata fetching
            });
        }
        
        return element;
    }
    
    private async getFileInfo(filePath: string): Promise<any> {
        try {
            if (!this.axiosInstance) {
                return null;
            }
            
            const response = await this.makeRequestWithCache(`/api/contents${filePath}`);
            return response.data;
        } catch (error) {
            return null;
        }
    }

    public setupAxiosInstance() {
        this.axiosInstance = axios.create({
            baseURL: this.jupyterServerUrl,
            headers: {
                'Authorization': `token ${this.jupyterToken}`
            },
            timeout: 30000, // 30 second timeout
            maxRedirects: 3,
            validateStatus: (status) => status < 500, // Don't throw for 4xx errors
            // Connection pooling and keep-alive settings
            maxContentLength: 100 * 1024 * 1024, // 100MB max content
            maxBodyLength: 100 * 1024 * 1024, // 100MB max body
        });

        // Add request interceptor for rate limiting
        this.axiosInstance.interceptors.request.use(async (config) => {
            await this.enforceRateLimit();
            return config;
        });

        // Add response interceptor for error handling
        this.axiosInstance.interceptors.response.use(
            (response) => response,
            (error) => {
                if (error.code === 'ECONNABORTED') {
                    console.log('Request timeout - server may be overloaded');
                    vscode.window.showWarningMessage('Request timeout - server may be overloaded. Consider increasing request delays.');
                } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                    console.log('Network error detected, may trigger reconnection');
                } else if (error.response?.status === 429) {
                    console.log('Rate limit exceeded - server is being overloaded');
                    vscode.window.showWarningMessage('Rate limit exceeded. The extension will automatically slow down requests.');
                    // Increase delay temporarily
                    this.requestDelay = Math.min(this.requestDelay * 2, 2000);
                }
                return Promise.reject(error);
            }
        );
    }

    public getAxiosInstance(): AxiosInstance | null {
        return this.axiosInstance;
    }

    private handleConnectionLoss(): void {
        console.log('Connection loss detected, emitting event...');
        
        // Prevent multiple connection loss events
        if (!this.isConnected) {
            console.log('Connection already marked as lost, skipping duplicate event');
            return;
        }
        
        this.isConnected = false;
        this.clearCache(); // Clear cache on connection loss
        this._onConnectionLost.fire();
    }

    public async checkConnectionHealth(): Promise<boolean> {
        if (!this.axiosInstance) {
            return false;
        }
        
        try {
            // Use a lightweight endpoint to check connectivity
            const response = await this.axiosInstance.get('api/status', { timeout: 5000 });
            const isHealthy = response.status === 200;
            
            if (isHealthy && !this.isConnected) {
                this.isConnected = true;
                console.log('Connection restored');
            }
            
            return isHealthy;
        } catch (error) {
            console.log('Health check failed:', error);
            if (this.isConnected) {
                this.handleConnectionLoss();
            }
            return false;
        }
    }

    private handleApiError(error: any, operation: string, showUserMessage: boolean = true): never {
        let errorMessage = `${operation} failed`;
        
        // Apply adaptive rate limiting based on error type
        this.adaptiveRateLimit(error);
        
        if (axios.isAxiosError(error)) {
            if (error.response) {
                errorMessage += `: ${error.response.status} - ${error.response.data?.message || error.response.statusText}`;
            } else if (error.code === 'ECONNABORTED') {
                errorMessage += ': Request timeout';
                if (showUserMessage) {
                    vscode.window.showWarningMessage('Request timeout - server may be overloaded. Slowing down requests.');
                }
            } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                errorMessage += ': Connection failed';
                this.handleConnectionLoss();
            } else {
                errorMessage += `: ${error.message}`;
            }
        } else if (error && typeof error === 'object') {
            // Handle non-axios errors that might have a message property
            errorMessage += `: ${error.message || 'Unknown error'}`;
        } else {
            errorMessage += `: ${String(error) || 'Unknown error'}`;
        }
        
        console.error(errorMessage);
        if (showUserMessage) {
            vscode.window.showErrorMessage(errorMessage);
        }
        
        throw new Error(errorMessage);
    }

    private ensureConnected(): boolean {
        if (!this.isConnected || !this.axiosInstance) {
            vscode.window.showErrorMessage('Not connected to Jupyter Server.');
            return false;
        }
        return true;
    }

    private async enforceRateLimit(): Promise<void> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.requestDelay) {
            const waitTime = this.requestDelay - timeSinceLastRequest;
            console.log(`Rate limiting: waiting ${waitTime}ms before next request`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRequestTime = Date.now();
    }

    private adaptiveRateLimit(error: any): void {
        if (error && (error.response?.status === 429 || error.code === 'ECONNABORTED')) {
            // Increase delay exponentially but cap at 5 seconds
            this.requestDelay = Math.min(this.requestDelay * 1.5, 5000);
            console.log(`Adaptive rate limit: increased delay to ${this.requestDelay}ms`);
        } else if (!error && this.requestDelay > 100) {
            // Gradually decrease delay on successful requests
            this.requestDelay = Math.max(this.requestDelay * 0.95, 100);
        }
    }

    private getCacheKey(url: string, method: string = 'GET'): string {
        return `${method}:${url}`;
    }

    private getFromCache(key: string): any | null {
        const cached = this.cache.get(key);
        if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            return cached.data;
        }
        this.cache.delete(key); // Remove expired cache
        return null;
    }

    private setCache(key: string, data: any): void {
        // Limit cache size to prevent memory issues
        if (this.cache.size > 100) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    private async makeRequestWithCache(url: string, options: any = {}): Promise<any> {
        const config = vscode.workspace.getConfiguration('jupyterFileExplorer');
        const enableCaching = config.get<boolean>('enableCaching', true);
        
        const method = options.method || 'GET';
        const cacheKey = this.getCacheKey(url, method);
        
        // Check cache for GET requests only and if caching is enabled
        if (method === 'GET' && enableCaching) {
            const cached = this.getFromCache(cacheKey);
            if (cached) {
                return { data: cached };
            }

            // Check for pending request to prevent duplicate requests
            const pendingKey = `pending:${cacheKey}`;
            if (this.pendingRequests.has(pendingKey)) {
                console.log(`Deduplicating request for ${url}`);
                try {
                    return await this.pendingRequests.get(pendingKey);
                } catch (error) {
                    // If pending request failed, continue with new request
                    this.pendingRequests.delete(pendingKey);
                }
            }
        }

        if (!this.axiosInstance) {
            throw new Error('Axios instance not initialized');
        }

        try {
            const requestPromise = method === 'GET' 
                ? this.axiosInstance.get(url, options)
                : this.axiosInstance.request({ url, ...options });

            if (method === 'GET' && enableCaching) {
                this.pendingRequests.set(`pending:${cacheKey}`, requestPromise);
            }

            const response = await requestPromise;

            // Validate response
            if (!response) {
                throw new Error('Empty response from server');
            }

            // Cache successful GET responses only if caching is enabled
            if (method === 'GET' && enableCaching && response.status < 300) {
                this.setCache(cacheKey, response.data);
            }

            // Apply adaptive rate limiting on successful requests
            this.adaptiveRateLimit(null);

            return response;
        } catch (error) {
            this.adaptiveRateLimit(error);
            throw error;
        } finally {
            if (method === 'GET' && enableCaching) {
                this.pendingRequests.delete(`pending:${cacheKey}`);
            }
        }
    }

    private sortItems(items: FileItem[]): FileItem[] {
        const config = this.getConfig();
        const sortBy = config.get<string>('sortFiles', 'type');
        const sortOrder = config.get<string>('sortOrder', 'asc');
        const isDescending = sortOrder === 'desc';

        // Create comparator functions for better performance
        const comparators = {
            type: (a: FileItem, b: FileItem) => {
                if (a.collapsible !== b.collapsible) {
                    return a.collapsible ? -1 : 1; // Directories first
                }
                return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
            },
            name: (a: FileItem, b: FileItem) => 
                a.label.toLowerCase().localeCompare(b.label.toLowerCase()),
            size: (a: FileItem, b: FileItem) => {
                if (a.collapsible !== b.collapsible) {
                    return a.collapsible ? -1 : 1; // Directories first
                }
                if (a.collapsible) return 0; // Both directories
                return (a.fileSize || 0) - (b.fileSize || 0);
            },
            modified: (a: FileItem, b: FileItem) => {
                if (a.collapsible !== b.collapsible) {
                    return a.collapsible ? -1 : 1; // Directories first
                }
                if (a.collapsible) return 0; // Both directories
                const dateA = a.lastModified?.getTime() || 0;
                const dateB = b.lastModified?.getTime() || 0;
                return dateA - dateB;
            }
        };

        const comparator = comparators[sortBy as keyof typeof comparators] || comparators.type;
        
        return items.sort((a, b) => {
            const result = comparator(a, b);
            return isDescending ? -result : result;
        });
    }





    async getChildren(element?: FileItem): Promise<FileItem[]> {
        if (!this.isConnected || !this.axiosInstance) {
            return [];
        }

        const path = element ? element.uri : this.remotePath;
        const finalPath = path.startsWith('/') ? path.substring(1) : path;
        const apiUrl = `api/contents/${finalPath}`;

        try {
            const response = await this.makeRequestWithCache(apiUrl);
            
            if (!response || !response.data) {
                console.warn(`No data received from ${apiUrl}`);
                return [];
            }
            
            if (!response.data.content || !Array.isArray(response.data.content)) {
                console.warn(`Invalid content structure from ${apiUrl}:`, response.data);
                return [];
            }
            
            const items = response.data.content.map((item: any) => 
                new FileItem(item.name, item.type === 'directory', item.path, item)
            );
            
            return this.sortItems(items);
        } catch (error) {
            console.error(`Error fetching children for ${apiUrl}:`, error);
            try {
                this.handleApiError(error, `Failed to fetch file list from ${apiUrl}`, true);
            } catch (handledError) {
                // Error was handled and thrown, but we need to return empty array for UI
                return [];
            }
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
            const extension = fileName.split('.').pop()?.toLowerCase();
            
            // Handle Jupyter notebooks specially
            if (extension === 'ipynb') {
                await this.openJupyterNotebook(filePath);
                return;
            }

            const uri = vscode.Uri.parse(`jupyter-remote:/${filePath}`).with({
                path: `/${filePath}`,
                fragment: fileName // This helps VS Code identify the file type
            });

            // Open the document with the custom URI
            const document = await vscode.workspace.openTextDocument(uri);
            
            // Set the language before showing the document for better syntax highlighting
            const languageId = this.getLanguageId(fileName);
            if (languageId !== 'plaintext') {
                await vscode.languages.setTextDocumentLanguage(document, languageId);
            }
            
            await vscode.window.showTextDocument(document);

        } catch (error) {
            console.error('Failed to open file:', error);
            vscode.window.showErrorMessage(`Failed to open file: ${error}`);
        }
    }

    private async openJupyterNotebook(filePath: string): Promise<void> {
        try {
            const uri = vscode.Uri.parse(`jupyter-remote:/${filePath}`);
            
            // Try to open as notebook first
            try {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'jupyter-notebook');
            } catch (notebookError) {
                // Fallback to text editor if notebook extension is not available
                console.log('Jupyter notebook extension not available, opening as text');
                const document = await vscode.workspace.openTextDocument(uri);
                await vscode.languages.setTextDocumentLanguage(document, 'json');
                await vscode.window.showTextDocument(document);
            }
        } catch (error) {
            console.error('Failed to open Jupyter notebook:', error);
            vscode.window.showErrorMessage(`Failed to open notebook: ${error}`);
        }
    }

    public async fetchFileContent(filePath: string): Promise<string> {
        if (!this.isConnected || !this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server.');
        }

        const apiUrl = `api/contents/${filePath}`;
        try {
            console.log(`Fetching file content from: ${apiUrl}`);
            const response = await this.makeRequestWithCache(apiUrl);
            
            if (!response.data) {
                throw new Error('No data received from server');
            }
            
            // Check if the file content format is available
            const content = response.data.content;
            const format = response.data.format;
            const type = response.data.type;
            
            console.log(`File type: ${type}, format: ${format}`);
            
            // Handle different content formats
            if (type === 'directory') {
                throw new Error('Cannot read directory as file');
            } else if (format === 'base64') {
                // For binary files, Jupyter returns base64
                try {
                    return Buffer.from(content, 'base64').toString('utf-8');
                } catch (decodeError) {
                    // If UTF-8 decoding fails, return as binary string
                    return Buffer.from(content, 'base64').toString('binary');
                }
            } else if (format === 'text' || format === 'json') {
                // For text files, content is directly available
                // For notebooks (JSON format), content might be an object that needs stringification
                if (typeof content === 'object' && content !== null) {
                    return JSON.stringify(content, null, 2);
                } else {
                    return content || '';
                }
            } else {
                // Default to treating as text
                if (typeof content === 'object' && content !== null) {
                    return JSON.stringify(content, null, 2);
                } else {
                    return content || '';
                }
            }
        } catch (error: any) {
            this.handleApiError(error, `Failed to fetch file content for ${filePath}`, false);
        }
    }

    private getLanguageId(fileName: string): string {
        // Handle special filenames first (before extension-based detection)
        const lowerFileName = fileName.toLowerCase();
        
        // Special Python project files
        if (lowerFileName === 'uv.lock' || lowerFileName === 'poetry.lock') {
            return 'toml';
        }
        
        // Special configuration files
        if (lowerFileName === 'dockerfile' || lowerFileName.startsWith('dockerfile.')) {
            return 'dockerfile';
        }
        
        if (lowerFileName === '.gitignore' || lowerFileName === 'gitignore') {
            return 'gitignore';
        }
        
        if (lowerFileName === '.env' || lowerFileName.startsWith('.env.')) {
            return 'dotenv';
        }
        
        // Cargo files (Rust)
        if (lowerFileName === 'cargo.lock' || lowerFileName === 'cargo.toml') {
            return 'toml';
        }
        
        // Python project files
        if (lowerFileName === 'pyproject.toml' || lowerFileName === 'pipfile' || lowerFileName === 'pipfile.lock') {
            return 'toml';
        }
        
        // Now handle extension-based detection
        const extension = fileName.split('.').pop()?.toLowerCase();
        switch (extension) {
            // Programming Languages
            case 'py':
                return 'python';
            case 'js':
                return 'javascript';
            case 'ts':
                return 'typescript';
            case 'java':
                return 'java';
            case 'c':
                return 'c';
            case 'cpp':
            case 'cc':
            case 'cxx':
                return 'cpp';
            case 'cs':
                return 'csharp';
            case 'php':
                return 'php';
            case 'rb':
                return 'ruby';
            case 'go':
                return 'go';
            case 'rs':
                return 'rust';
            case 'swift':
                return 'swift';
            case 'kt':
                return 'kotlin';
            case 'scala':
                return 'scala';
            case 'r':
                return 'r';
            case 'matlab':
            case 'm':
                return 'matlab';
            
            // Database
            case 'sql':
                return 'sql';
            case 'psql':
                return 'postgres';
            
            // Web Technologies
            case 'html':
            case 'htm':
                return 'html';
            case 'css':
                return 'css';
            case 'scss':
                return 'scss';
            case 'sass':
                return 'sass';
            case 'less':
                return 'less';
            case 'jsx':
                return 'javascriptreact';
            case 'tsx':
                return 'typescriptreact';
            case 'vue':
                return 'vue';
            
            // Data Formats
            case 'json':
                return 'json';
            case 'xml':
                return 'xml';
            case 'yaml':
            case 'yml':
                return 'yaml';
            case 'toml':
                return 'toml';
            case 'csv':
                return 'csv';
            
            // Markup Languages
            case 'md':
            case 'markdown':
                return 'markdown';
            case 'rst':
                return 'restructuredtext';
            case 'tex':
                return 'latex';
            
            // Shell Scripts
            case 'sh':
            case 'bash':
                return 'shellscript';
            case 'ps1':
                return 'powershell';
            case 'bat':
            case 'cmd':
                return 'bat';
            
            // Configuration Files
            case 'dockerfile':
                return 'dockerfile';
            case 'gitignore':
                return 'gitignore';
            case 'env':
                return 'dotenv';
            case 'ini':
                return 'ini';
            case 'conf':
            case 'config':
                return 'properties';
            case 'lock':
                // Most .lock files are TOML or JSON, default to TOML for Python ecosystem
                return 'toml';
            
            // Notebook files
            case 'ipynb':
                return 'json'; // Fallback for when notebook editor is not available
            
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
            
            // Invalidate cache for this file and its parent directory
            this.invalidateCacheForPath(filePath);
            vscode.window.showInformationMessage('File saved to Jupyter Server.');
        } catch (error) {
            vscode.window.showErrorMessage('Failed to save file to Jupyter Server.');
        }
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        // For now, we don't support watching files.
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
        if (!this.isConnected || !this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }

        const filePath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        const apiUrl = `api/contents/${filePath}`;
        
        return this.axiosInstance.get(apiUrl).then(response => {
            const data = response.data;
            
            const isDirectory = data.type === 'directory';
            const lastModified = data.last_modified ? new Date(data.last_modified).getTime() : Date.now();
            const created = data.created ? new Date(data.created).getTime() : lastModified;
            
            return {
                type: isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
                ctime: created,
                mtime: lastModified,
                size: data.size || 0
            };
        }).catch(error => {
            console.error('Failed to stat file:', error);
            // Fallback to basic stat if server query fails
            return {
                type: vscode.FileType.File,
                ctime: Date.now(),
                mtime: Date.now(),
                size: 0
            };
        });
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
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
        
        try {
            const content = await this.fetchFileContent(uri.path.slice(1));
            return Buffer.from(content, 'utf8');
        } catch (error) {
            console.error('Failed to read file:', error);
            throw vscode.FileSystemError.FileNotFound(`Failed to read file: ${error}`);
        }
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
    }    async delete(uri: vscode.Uri, options: { recursive: boolean; }): Promise<void> {
        if (!this.isConnected || !this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }
    
        const itemPath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        
        try {
            // First, check if this is a directory and if it has contents
            const statResult = this.stat(uri);
            const stat = await Promise.resolve(statResult);
            
            if (stat.type === vscode.FileType.Directory && options.recursive) {
                // For directories, we need to handle recursive deletion
                console.log(`Attempting recursive deletion of directory: ${itemPath}`);
                await this.deleteDirectoryRecursive(itemPath);
            } else {
                // For files or non-recursive deletion, use simple delete
                console.log(`Attempting simple deletion of: ${itemPath}`);
                const apiUrl = `api/contents/${itemPath}`;
                const response = await this.axiosInstance.delete(apiUrl);
                console.log(`Delete response:`, response.status, response.statusText);
            }
            
            const parentUri = vscode.Uri.parse(`jupyter-remote:${this.extractParentPath(uri.path)}`);
            this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: parentUri }]);

        } catch (error: any) {
            console.error('Delete operation failed:', {
                path: itemPath,
                error: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data
            });
            
            let errorMessage = `Failed to delete ${itemPath}`;
            if (error.response?.data?.message) {
                const serverMessage = error.response.data.message;
                if (serverMessage.includes('not empty')) {
                    errorMessage += ': Directory contains files that could not be deleted. This might be due to hidden files, permission issues, or server-side restrictions.';
                } else {
                    errorMessage += `: ${serverMessage}`;
                }
            } else if (error.response?.status === 400) {
                errorMessage += ': Bad Request - The server cannot delete this item. It may contain files or be protected.';
            } else if (error.response?.status === 404) {
                errorMessage += ': Item not found';
            } else if (error.response?.status === 403) {
                errorMessage += ': Permission denied';
            } else {
                errorMessage += `: ${error.message}`;
            }
            
            vscode.window.showErrorMessage(errorMessage);
            throw vscode.FileSystemError.Unavailable(errorMessage);
        }
    }

    private async deleteDirectoryRecursive(dirPath: string): Promise<void> {
        if (!this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server');
        }

        try {
            console.log(`Starting recursive deletion of directory: ${dirPath}`);
            
            // Always try recursive approach first for directories with contents
            // Get directory contents first
            const listUrl = `api/contents/${dirPath}`;
            console.log(`Fetching directory contents from: ${listUrl}`);
            const response = await this.axiosInstance.get(listUrl);
            const contents = response.data.content || [];

            console.log(`Directory ${dirPath} contains ${contents.length} items:`, contents.map((item: any) => `${item.name} (${item.type})`));

            // If directory is empty, try simple deletion
            if (contents.length === 0) {
                console.log(`Directory ${dirPath} is empty, using simple delete`);
                const deleteUrl = `api/contents/${dirPath}`;
                await this.axiosInstance.delete(deleteUrl);
                console.log(`Successfully deleted empty directory: ${dirPath}`);
                return;
            }

            // Delete all contents first (deepest first for proper cleanup)
            for (const item of contents) {
                const itemPath = item.path;
                console.log(`Deleting item: ${itemPath} (type: ${item.type})`);
                
                if (item.type === 'directory') {
                    // Recursively delete subdirectories
                    await this.deleteDirectoryRecursive(itemPath);
                } else {
                    // Delete files with retry for potentially locked files
                    await this.deleteFileWithRetry(itemPath);
                }
            }

            // Now delete the empty directory
            console.log(`All contents deleted, now deleting empty directory: ${dirPath}`);
            const deleteUrl = `api/contents/${dirPath}`;
            console.log(`DELETE directory request to: ${deleteUrl}`);
            
            try {
                await this.axiosInstance.delete(deleteUrl);
                console.log(`Successfully deleted directory: ${dirPath}`);
            } catch (dirError: any) {
                console.error(`Failed to delete directory ${dirPath}:`, dirError.response?.data || dirError.message);
                // If it still says "not empty", let's check what's left
                if (dirError.response?.data?.message?.includes('not empty')) {
                    console.log(`Directory still reported as not empty, checking contents again...`);
                    try {
                        const checkResponse = await this.axiosInstance.get(listUrl);
                        const remainingContents = checkResponse.data.content || [];
                        console.log(`Remaining contents in ${dirPath}:`, remainingContents.map((item: any) => `${item.name} (${item.type})`));
                        
                        // Try to delete remaining items
                        for (const item of remainingContents) {
                            console.log(`Retrying deletion of: ${item.path}`);
                            try {
                                if (item.type === 'directory') {
                                    await this.deleteDirectoryRecursive(item.path);
                                } else {
                                    await this.axiosInstance.delete(`api/contents/${item.path}`);
                                }
                            } catch (retryError) {
                                console.error(`Failed to delete remaining item ${item.path}:`, retryError);
                            }
                        }
                        
                        // Try directory deletion one more time
                        await this.axiosInstance.delete(deleteUrl);
                        console.log(`Successfully deleted directory: ${dirPath} (after cleanup)`);
                    } catch (finalError) {
                        console.error(`Final deletion attempt failed for ${dirPath}:`, finalError);
                        throw dirError;
                    }
                } else {
                    throw dirError;
                }
            }

        } catch (error: any) {
            console.error(`Failed to delete directory ${dirPath}:`, error.response?.data || error.message);
            throw error;
        }
    }

    private async deleteFileWithRetry(itemPath: string, maxRetries: number = 3, delay: number = 1000): Promise<void> {
        if (!this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server');
        }

        const fileDeleteUrl = `api/contents/${itemPath}`;
        console.log(`DELETE file request to: ${fileDeleteUrl}`);
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.axiosInstance.delete(fileDeleteUrl);
                console.log(`Successfully deleted file: ${itemPath} (attempt ${attempt})`);
                return;
            } catch (fileError: any) {
                console.error(`Failed to delete file ${itemPath} (attempt ${attempt}):`, fileError.response?.data || fileError.message);
                
                if (attempt === maxRetries) {
                    // On final attempt, provide more informative error message
                    const extension = itemPath.split('.').pop()?.toLowerCase();
                    console.warn(`Failed to delete file ${itemPath} after ${maxRetries} attempts. Extension: ${extension}`);
                    throw new Error(`Failed to delete file ${itemPath} after ${maxRetries} attempts. The file may be locked, in use, or protected by the server.`);
                }
                
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    private async forceDelete(uri: vscode.Uri): Promise<void> {
        if (!this.isConnected || !this.axiosInstance) {
            throw vscode.FileSystemError.NoPermissions('Not connected to Jupyter Server.');
        }

        const itemPath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
        
        try {
            console.log(`Starting force deletion of: ${itemPath}`);
            
            // Strategy 1: Try normal deletion first
            try {
                await this.delete(uri, { recursive: true });
                vscode.window.showInformationMessage(`Successfully force deleted ${itemPath}`);
                return;
            } catch (error) {
                console.log(`Normal deletion failed, trying force strategies...`);
            }

            // Strategy 2: Try to list and delete all files individually with extended retry
            await this.forceDeleteRecursive(itemPath);
            
            vscode.window.showInformationMessage(`Successfully force deleted ${itemPath} using aggressive deletion`);
            
            const parentUri = vscode.Uri.parse(`jupyter-remote:${this.extractParentPath(uri.path)}`);
            this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
            this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: parentUri }]);

        } catch (error: any) {
            console.error('Force delete failed:', error);
            const errorMessage = `Force delete failed for ${itemPath}: ${error.message}. Some files may be permanently locked or protected by the server.`;
            vscode.window.showErrorMessage(errorMessage);
            throw vscode.FileSystemError.Unavailable(errorMessage);
        }
    }

    private async forceDeleteRecursive(dirPath: string, maxAttempts: number = 5): Promise<void> {
        if (!this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server');
        }

        console.log(`Force deleting directory: ${dirPath}`);
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                // Get directory contents
                const listUrl = `api/contents/${dirPath}`;
                const response = await this.axiosInstance.get(listUrl);
                const contents = response.data.content || [];

                console.log(`Attempt ${attempt}: Directory ${dirPath} contains ${contents.length} items`);

                if (contents.length === 0) {
                    // Directory is empty, try to delete it
                    await this.axiosInstance.delete(`api/contents/${dirPath}`);
                    console.log(`Successfully deleted empty directory: ${dirPath}`);
                    return;
                }

                // Delete all items with extended retry and ignore individual failures
                const deletePromises = contents.map(async (item: any) => {
                    try {
                        if (item.type === 'directory') {
                            await this.forceDeleteRecursive(item.path, 3); // Fewer attempts for subdirectories
                        } else {
                            await this.deleteFileWithRetry(item.path, 5, 500); // More attempts, shorter delay
                        }
                    } catch (error) {
                        console.warn(`Failed to delete ${item.path}, continuing...`);
                        // Continue with other files even if some fail
                    }
                });

                // Wait for all deletion attempts to complete (using Promise.all with error handling)
                await Promise.all(deletePromises.map((p: Promise<void>) => p.catch(() => {})));

                // Wait a bit for server to process
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));

                // Try to delete the directory again
                try {
                    await this.axiosInstance.delete(`api/contents/${dirPath}`);
                    console.log(`Successfully deleted directory: ${dirPath} on attempt ${attempt}`);
                    return;
                } catch (dirError) {
                    console.log(`Directory deletion failed on attempt ${attempt}, checking remaining contents...`);
                }

            } catch (error: any) {
                console.error(`Force delete attempt ${attempt} failed:`, error.message);
                
                if (attempt === maxAttempts) {
                    throw new Error(`Failed to force delete ${dirPath} after ${maxAttempts} attempts. Directory may contain locked files or have server-side protection.`);
                }
                
                // Wait longer between attempts
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
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
            this.invalidateCacheForPath(parentPath);
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
            this.invalidateCacheForPath(parentPath);
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
        const result = await vscode.window.showWarningMessage(
            `Are you sure you want to delete ${item.label}?`, 
            { modal: true }, 
            'Delete', 
            'Force Delete'
        );
        
        if (result === 'Delete') {
            const uri = vscode.Uri.parse(`jupyter-remote:${item.uri}`);
            await this.delete(uri, { recursive: true });
            this.invalidateCacheForPath(item.uri);
            this.refresh();
        } else if (result === 'Force Delete') {
            const uri = vscode.Uri.parse(`jupyter-remote:${item.uri}`);
            await this.forceDelete(uri);
            this.invalidateCacheForPath(item.uri);
            this.refresh();
        }
    }

    async forceDeleteFile(item: FileItem): Promise<void> {
        const result = await vscode.window.showWarningMessage(
            `Force delete will attempt aggressive deletion of ${item.label}. This may take longer and cannot be undone. Continue?`, 
            { modal: true }, 
            'Force Delete'
        );
        
        if (result === 'Force Delete') {
            const uri = vscode.Uri.parse(`jupyter-remote:${item.uri}`);
            await this.forceDelete(uri);
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

    private async processFileOperation(
        files: vscode.Uri[], 
        targetPath: string, 
        operation: 'upload' | 'download',
        operationFn: (filePath: string, targetPath: string) => Promise<void>
    ): Promise<void> {
        let successCount = 0;
        let errorCount = 0;

        const operationName = operation === 'upload' ? 'upload' : 'download';

        for (const fileUri of files) {
            try {
                await operationFn(fileUri.fsPath, targetPath);
                successCount++;
            } catch (error) {
                console.error(`Failed to ${operationName} ${path.basename(fileUri.fsPath)}:`, error);
                vscode.window.showErrorMessage(`Failed to ${operationName} ${path.basename(fileUri.fsPath)}: ${error}`);
                errorCount++;
            }
        }

        this.refresh();

        if (successCount > 0) {
            vscode.window.showInformationMessage(`Successfully ${operationName}ed ${successCount} file(s).`);
        }
        if (errorCount > 0) {
            vscode.window.showWarningMessage(`Failed to ${operationName} ${errorCount} file(s).`);
        }
    }

    async uploadFile(targetDirectory?: FileItem): Promise<void> {
        if (!this.ensureConnected()) {
            return;
        }

        const parentPath = targetDirectory ? targetDirectory.uri : this.remotePath;
        
        const fileUris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            openLabel: 'Upload'
        });

        if (!fileUris || fileUris.length === 0) {
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        for (const fileUri of fileUris) {
            try {
                await this.uploadSingleFile(fileUri.fsPath, parentPath);
                successCount++;
            } catch (error) {
                const fileName = path.basename(fileUri.fsPath);
                this.handleApiError(error, `Failed to upload ${fileName}`, false);
                errorCount++;
            }
        }

        this.refresh();

        if (successCount > 0) {
            vscode.window.showInformationMessage(`Successfully uploaded ${successCount} file(s).`);
        }
        if (errorCount > 0) {
            vscode.window.showWarningMessage(`Failed to upload ${errorCount} file(s).`);
        }
    }

    async uploadFolder(targetDirectory?: FileItem): Promise<void> {
        if (!this.ensureConnected()) {
            return;
        }

        const parentPath = targetDirectory ? targetDirectory.uri : this.remotePath;
        
        const folderUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: true,
            openLabel: 'Upload Folder'
        });

        if (!folderUris || folderUris.length === 0) {
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        for (const folderUri of folderUris) {
            try {
                const folderName = path.basename(folderUri.fsPath);
                const targetPath = `${parentPath}/${folderName}`.replace('//', '/');
                await this.uploadFolderRecursive(folderUri.fsPath, targetPath);
                successCount++;
            } catch (error) {
                console.error(`Failed to upload folder ${path.basename(folderUri.fsPath)}:`, error);
                vscode.window.showErrorMessage(`Failed to upload folder ${path.basename(folderUri.fsPath)}: ${error}`);
                errorCount++;
            }
        }

        this.refresh();

        if (successCount > 0) {
            vscode.window.showInformationMessage(`Successfully uploaded ${successCount} folder(s).`);
        }
        if (errorCount > 0) {
            vscode.window.showWarningMessage(`Failed to upload ${errorCount} folder(s).`);
        }
    }

    async downloadFile(item: FileItem): Promise<void> {
        if (!this.ensureConnected()) {
            return;
        }

        if (item.collapsible) {
            vscode.window.showErrorMessage('Cannot download a directory. Please select a file.');
            return;
        }

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(item.label),
            saveLabel: 'Download'
        });

        if (!saveUri) {
            return;
        }

        try {
            const cleanPath = item.uri.startsWith('/') ? item.uri.substring(1) : item.uri;
            const apiUrl = `api/contents/${cleanPath}`;
            
            const response = await this.makeRequestWithCache(apiUrl);
            
            if (response.data.type === 'file') {
                const content = response.data.content;
                let fileContent: Buffer;
                
                if (response.data.format === 'base64') {
                    fileContent = Buffer.from(content, 'base64');
                } else {
                    fileContent = Buffer.from(content, 'utf8');
                }
                
                await fs.promises.writeFile(saveUri.fsPath, fileContent);
                vscode.window.showInformationMessage(`Successfully downloaded ${item.label}`);
            } else {
                vscode.window.showErrorMessage('Selected item is not a file.');
            }
        } catch (error) {
            this.handleApiError(error, `Failed to download ${item.label}`, false);
        }
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
        
        // Handle external file drops
        const uriListTransfer = dataTransfer.get('text/uri-list');
        if (uriListTransfer) {
            await this.handleExternalFileUpload(uriListTransfer, target);
            return;
        }
        
        vscode.window.showInformationMessage('No valid files detected in drop operation.');
    }

    private async handleExternalFileUpload(uriListTransfer: vscode.DataTransferItem, target: FileItem | undefined): Promise<void> {
        try {
            const uriListData = await uriListTransfer.asString();
            console.log('URI list data:', uriListData);
            
            const lines = uriListData.split('\n').filter(line => line.trim() && !line.startsWith('#'));
            const uris = lines
                .map(line => {
                    try {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('file://')) {
                            return vscode.Uri.parse(trimmed);
                        } else if (fs.existsSync(trimmed)) {
                            return vscode.Uri.file(trimmed);
                        }
                        return null;
                    } catch (error) {
                        console.error('Failed to parse URI:', line, error);
                        return null;
                    }
                })
                .filter(uri => uri !== null) as vscode.Uri[];

            if (uris.length === 0) {
                console.log('No valid URIs found in drop data');
                return;
            }

            // Determine target path
            let targetPath: string;
            if (target) {
                targetPath = target.collapsible ? target.uri : this.extractParentPath(target.uri);
            } else {
                targetPath = this.remotePath;
            }

            console.log(`Uploading ${uris.length} items to: ${targetPath}`);

            let successCount = 0;
            let errorCount = 0;

            for (const uri of uris) {
                if (uri.scheme === 'file') {
                    try {
                        const stat = await fs.promises.stat(uri.fsPath);
                        if (stat.isFile()) {
                            await this.uploadSingleFile(uri.fsPath, targetPath);
                            successCount++;
                        } else if (stat.isDirectory()) {
                            const folderName = path.basename(uri.fsPath);
                            await this.uploadFolderRecursive(uri.fsPath, `${targetPath}/${folderName}`.replace('//', '/'));
                            successCount++;
                        }
                    } catch (error) {
                        console.error(`Failed to upload ${path.basename(uri.fsPath)}:`, error);
                        vscode.window.showErrorMessage(`Failed to upload ${path.basename(uri.fsPath)}: ${error}`);
                        errorCount++;
                    }
                }
            }

            this.refresh();

            if (successCount > 0) {
                vscode.window.showInformationMessage(`Successfully uploaded ${successCount} item(s) via drag & drop.`);
            }
            if (errorCount > 0) {
                vscode.window.showWarningMessage(`Failed to upload ${errorCount} item(s). Check the output for details.`);
            }

        } catch (error) {
            console.error('External file upload failed:', error);
            vscode.window.showErrorMessage(`Failed to upload files: ${error}`);
        }
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

    private async uploadSingleFile(localFilePath: string, remotePath: string): Promise<void> {
        if (!this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server');
        }

        try {
            const fileName = path.basename(localFilePath);
            const targetPath = `${remotePath}/${fileName}`.replace('//', '/');
            const cleanTargetPath = targetPath.startsWith('/') ? targetPath.substring(1) : targetPath;
            
            console.log(`Uploading file: ${localFilePath}`);
            console.log(`Target path: ${targetPath}`);
            console.log(`Clean target path: ${cleanTargetPath}`);
            console.log(`API URL will be: api/contents/${cleanTargetPath}`);
            
            const fileContent = await fs.promises.readFile(localFilePath);
            
            // Determine if file is binary or text
            const isBinary = this.isBinaryFile(localFilePath);
            console.log(`File is binary: ${isBinary}`);
            
            const apiUrl = `api/contents/${cleanTargetPath}`;
            
            const requestData = {
                type: 'file',
                format: isBinary ? 'base64' : 'text',
                content: isBinary ? fileContent.toString('base64') : fileContent.toString('utf8')
            };
            
            console.log(`Request data:`, {
                type: requestData.type,
                format: requestData.format,
                contentLength: requestData.content.length
            });
            
            const response = await this.axiosInstance.put(apiUrl, requestData);
            console.log(`Successfully uploaded: ${fileName}`, response.status);
            
        } catch (error: any) {
            console.error('Upload failed:', error);
            console.error('Error details:', {
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                url: error.config?.url,
                method: error.config?.method
            });
            throw new Error(`Upload failed for ${path.basename(localFilePath)}: ${error.response?.data?.message || error.message}`);
        }
    }

    private async uploadFolderRecursive(localFolderPath: string, remotePath: string): Promise<void> {
        if (!this.axiosInstance) {
            throw new Error('Not connected to Jupyter Server');
        }

        try {
            console.log(`Uploading folder: ${localFolderPath}`);
            console.log(`Remote path: ${remotePath}`);
            
            // Create the directory first
            const cleanRemotePath = remotePath.startsWith('/') ? remotePath.substring(1) : remotePath;
            const apiUrl = `api/contents/${cleanRemotePath}`;
            
            console.log(`Creating directory at: ${apiUrl}`);
            
            const dirResponse = await this.axiosInstance.put(apiUrl, {
                type: 'directory'
            });
            console.log(`Directory created successfully:`, dirResponse.status);
            
            // Read directory contents
            const entries = await fs.promises.readdir(localFolderPath, { withFileTypes: true });
            console.log(`Found ${entries.length} entries in folder`);
            
            for (const entry of entries) {
                const localEntryPath = path.join(localFolderPath, entry.name);
                const remoteEntryPath = `${remotePath}/${entry.name}`.replace('//', '/');
                
                console.log(`Processing entry: ${entry.name} (${entry.isDirectory() ? 'directory' : 'file'})`);
                
                if (entry.isDirectory()) {
                    await this.uploadFolderRecursive(localEntryPath, remoteEntryPath);
                } else if (entry.isFile()) {
                    await this.uploadSingleFile(localEntryPath, remotePath);
                }
            }
            
        } catch (error: any) {
            console.error('Folder upload failed:', error);
            console.error('Folder upload error details:', {
                message: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                url: error.config?.url,
                method: error.config?.method
            });
            throw new Error(`Folder upload failed for ${path.basename(localFolderPath)}: ${error.response?.data?.message || error.message}`);
        }
    }

    private isBinaryFile(filePath: string): boolean {
        const ext = path.extname(filePath).toLowerCase();
        const binaryExtensions = [
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.tiff', '.webp',
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.zip', '.tar', '.gz', '.rar', '.7z',
            '.exe', '.dll', '.so', '.dylib',
            '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
            '.bin', '.dat', '.db', '.sqlite',
            '.woff', '.woff2', '.ttf', '.otf'
        ];
        return binaryExtensions.includes(ext);
    }
}

export class FileItem extends vscode.TreeItem {
    public fileSize?: number;
    public lastModified?: Date;
    
    constructor(
        public readonly label: string,
        public readonly collapsible: boolean,
        public readonly uri: string,
        fileInfo?: any
    ) {
        super(label, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        
        // Store file metadata if available
        if (fileInfo) {
            this.fileSize = fileInfo.size;
            this.lastModified = fileInfo.last_modified ? new Date(fileInfo.last_modified) : undefined;
        }
        
        this.tooltip = this.buildTooltip();
        this.description = this.buildDescription();
        this.contextValue = collapsible ? 'directory' : 'file';
        this.iconPath = this.getIcon();

        if (!collapsible) {
            this.command = {
                command: 'jupyterFileExplorer.openFile',
                title: 'Open File',
                arguments: [this.uri]
            };
        }
    }
    
    public updateMetadata(fileInfo: any): void {
        this.fileSize = fileInfo.size;
        this.lastModified = fileInfo.last_modified ? new Date(fileInfo.last_modified) : undefined;
        this.tooltip = this.buildTooltip();
        this.description = this.buildDescription();
    }
    
    private buildTooltip(): string {
        let tooltip = this.label;
        
        if (this.collapsible) {
            tooltip += ' (Directory)';
        } else {
            if (this.fileSize !== undefined) {
                tooltip += `\nSize: ${this.formatFileSize(this.fileSize)}`;
            }
            
            if (this.lastModified) {
                tooltip += `\nModified: ${this.lastModified.toLocaleDateString()} ${this.lastModified.toLocaleTimeString()}`;
            }
        }
        
        return tooltip;
    }
    
    private buildDescription(): string {
        if (this.collapsible) {
            return '';
        }
        
        const fileName = this.label as string;
        const extension = fileName.split('.').pop()?.toLowerCase() || '';
        let description = '';
        
        // Add file type description
        if (extension) {
            description = extension.toUpperCase();
        }
        
        // Add file size if available
        if (this.fileSize !== undefined) {
            description += description ? ` • ${this.formatFileSize(this.fileSize)}` : this.formatFileSize(this.fileSize);
        }
        
        return description;
    }
    
    private getIcon(): vscode.ThemeIcon {
        if (this.collapsible) {
            return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'));
        }
        
        const fileName = this.label as string;
        const extension = fileName.split('.').pop()?.toLowerCase() || '';
        const lowerFileName = fileName.toLowerCase();
        const isHidden = fileName.startsWith('.');
        
        // Special files first
        if (lowerFileName === 'readme.md' || lowerFileName === 'readme') {
            return new vscode.ThemeIcon('book', new vscode.ThemeColor('charts.blue'));
        }
        if (lowerFileName === 'dockerfile' || lowerFileName.startsWith('dockerfile.')) {
            return new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.purple'));
        }
        if (lowerFileName === '.gitignore') {
            return new vscode.ThemeIcon('git-branch', new vscode.ThemeColor('charts.gray'));
        }
        if (lowerFileName === '.env' || lowerFileName.startsWith('.env.')) {
            return new vscode.ThemeIcon('gear', new vscode.ThemeColor('charts.gray'));
        }
        if (lowerFileName === 'package.json' || lowerFileName === 'pyproject.toml') {
            return new vscode.ThemeIcon('json', new vscode.ThemeColor('charts.green'));
        }
        if (lowerFileName === 'uv.lock' || lowerFileName === 'poetry.lock' || lowerFileName === 'cargo.lock') {
            return new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.orange'));
        }
        if (lowerFileName === 'makefile') {
            return new vscode.ThemeIcon('tools', new vscode.ThemeColor('charts.purple'));
        }
        
        // For hidden files, use a dimmed color
        const iconColor = isHidden ? new vscode.ThemeColor('charts.gray') : undefined;
        
        // Extension-based icons with colors
        switch (extension) {
            case 'py':
                return new vscode.ThemeIcon('symbol-class', iconColor || new vscode.ThemeColor('charts.blue'));
            case 'js':
            case 'jsx':
                return new vscode.ThemeIcon('symbol-function', iconColor || new vscode.ThemeColor('charts.yellow'));
            case 'ts':
            case 'tsx':
                return new vscode.ThemeIcon('symbol-interface', iconColor || new vscode.ThemeColor('charts.blue'));
            case 'json':
                return new vscode.ThemeIcon('json', iconColor || new vscode.ThemeColor('charts.green'));
            case 'ipynb':
                return new vscode.ThemeIcon('notebook', iconColor || new vscode.ThemeColor('charts.orange'));
            case 'md':
            case 'markdown':
                return new vscode.ThemeIcon('markdown', iconColor || new vscode.ThemeColor('charts.blue'));
            case 'sql':
                return new vscode.ThemeIcon('database', iconColor || new vscode.ThemeColor('charts.purple'));
            case 'toml':
                return new vscode.ThemeIcon('settings-gear', iconColor || new vscode.ThemeColor('charts.gray'));
            case 'yaml':
            case 'yml':
                return new vscode.ThemeIcon('symbol-structure', iconColor || new vscode.ThemeColor('charts.gray'));
            case 'html':
                return new vscode.ThemeIcon('code', iconColor || new vscode.ThemeColor('charts.red'));
            case 'css':
            case 'scss':
            case 'sass':
                return new vscode.ThemeIcon('symbol-color', iconColor || new vscode.ThemeColor('charts.blue'));
            case 'xml':
                return new vscode.ThemeIcon('symbol-structure', iconColor || new vscode.ThemeColor('charts.green'));
            case 'csv':
                return new vscode.ThemeIcon('graph', iconColor || new vscode.ThemeColor('charts.green'));
            case 'png':
            case 'jpg':
            case 'jpeg':
            case 'gif':
            case 'svg':
            case 'webp':
                return new vscode.ThemeIcon('file-media', iconColor || new vscode.ThemeColor('charts.purple'));
            case 'pdf':
                return new vscode.ThemeIcon('file-pdf', iconColor || new vscode.ThemeColor('charts.red'));
            case 'zip':
            case 'tar':
            case 'gz':
            case 'rar':
                return new vscode.ThemeIcon('file-zip', iconColor || new vscode.ThemeColor('charts.orange'));
            case 'sh':
            case 'bash':
                return new vscode.ThemeIcon('terminal', iconColor || new vscode.ThemeColor('charts.green'));
            case 'log':
                return new vscode.ThemeIcon('output', iconColor || new vscode.ThemeColor('charts.gray'));
            case 'txt':
                return new vscode.ThemeIcon('file-text', iconColor || new vscode.ThemeColor('charts.gray'));
            case 'lock':
                return new vscode.ThemeIcon('lock', iconColor || new vscode.ThemeColor('charts.orange'));
            default:
                return new vscode.ThemeIcon('file', iconColor || new vscode.ThemeColor('charts.gray'));
        }
    }
    
    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 B';
        
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
}

export class JupyterContentProvider implements vscode.TextDocumentContentProvider {
    constructor(private fileExplorerProvider: FileExplorerProvider) {}

    async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
        // Leverage the existing fetchFileContent method with caching and optimizations
        return this.fileExplorerProvider.fetchFileContent(uri.path.slice(1));
    }
}
