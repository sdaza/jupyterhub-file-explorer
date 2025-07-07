# JupyterHub File Explorer

JupyterHub File Explorer is a Visual Studio Code extension that allows you to browse and manage files on a remote Jupyter Server directly from your VS Code environment.

## Features

- **Intuitive Connection Management**: Save and switch between multiple Jupyter Server configurations.
- **Complete File Management**: Create, edit, delete, rename, and organize files and folders on remote servers.
- **Drag & Drop Support**: Upload files from your OS or move files within the remote server by dragging and dropping.
- **Enhanced File Editing**: Automatic syntax highlighting for popular programming languages and configuration files.
- **Auto-Reconnect**: Automatically reconnect when connection is lost and remember your last directory.

## Installation

1. Open Visual Studio Code.
2. Go to the Extensions view (`Ctrl+Shift+X`).
3. Search for "JupyterHub File Explorer" and click **Install**.

## Usage

### Connecting to a Server

- When you first open the **JupyterHub** view, you will see a welcome message with options to connect.
- Click the **Connect** button (plug icon) in the view's title bar, or use the Command Palette (`Ctrl+Shift+P`).
- You will be prompted to select from your saved connections or add a new one.

### Managing Connections

All connection commands can be accessed from the Command Palette (`Ctrl+Shift+P`):

- **`JHE: Add New Jupyter Connection`**: Prompts you to enter a name, URL, token, and remote path for a new server connection.
- **`JHE: Select Jupyter Connection`**: Shows a list of your saved connections, allowing you to switch the explorer to a different server.
- **`JHE: Remove Jupyter Connection`**: Shows a list of your saved connections to choose one to remove.
- **`JHE: Disconnect from Jupyter Server`**: Disconnects from the current server. You can also click the **Disconnect** button (sign-out icon) in the view's title bar.

### Exploring and Managing Files

Once connected, the file explorer shows your remote files and folders. You can:

- **Create**: New files and folders using toolbar buttons or right-click context menus
- **Upload**: Drag files from your computer or use upload buttons
- **Download**: Right-click any file to download it
- **Edit**: Click any file to open it with syntax highlighting
- **Move**: Drag files between folders within the remote server
- **Delete**: Remove files and folders (including non-empty folders)

## Configuration

Your server connections are stored in VS Code settings. Use the extension's UI to manage them, or edit your `settings.json` file directly.

The configuration is stored under the `jupyterFileExplorer.connections` property:

```json
"jupyterFileExplorer.connections": [
    {
        "name": "My Dev Server",
        "url": "http://localhost:8888/",
        "token": "your-secret-token",
        "remotePath": "user/username/projects"
    },
    {
        "name": "JupyterHub Production",
        "url": "https://my-jupyterhub.com/",
        "token": "another-token",
        "remotePath": "user/username/lab"
    }
]
```

### Connection Parameters

- **name**: A descriptive name for your connection
- **url**: The base URL of your Jupyter Server or JupyterHub instance
- **token**: Your Jupyter authentication token
- **remotePath**: The remote directory path to browse

### JupyterHub Connections

For JupyterHub, include your username in the remote path:

```json
{
  "name": "JupyterHub",
  "url": "https://jupyterhub.example.com",
  "token": "your-token-here",
  "remotePath": "/user/your-username/"
}
```

### Settings

You can customize the extension's behavior:

- **`jupyterFileExplorer.autoReconnect`** (default: `true`): Automatically reconnect when connection is lost
- **`jupyterFileExplorer.reconnectInterval`** (default: `5000`): Time between reconnection attempts  
- **`jupyterFileExplorer.maxReconnectAttempts`** (default: `3`): Maximum reconnection attempts
- **`jupyterFileExplorer.rememberLastDirectory`** (default: `true`): Remember last opened directory

## Troubleshooting

**Common Issues:**
- **Connection Failed**: Check your server URL, token, and ensure the Jupyter Server is running
- **Files Not Loading**: Verify your remote path and permissions
- **File Opening Issues**: Try clicking "Open in Text Editor" if an error appears

**Need Help?**
1. Check the VS Code Output panel for error messages
2. Verify your connection settings
3. Report issues on [GitHub](https://github.com/sdaza/jupyterhub-file-explorer)

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

