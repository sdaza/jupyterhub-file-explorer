# Jupyter File Explorer

Jupyter File Explorer is a Visual Studio Code extension that allows you to browse and manage files on a remote Jupyter Server directly from your VS Code environment.

## Features

- **Multi-Connection Management**: Save and quickly switch between multiple Jupyter Server connections.
- **Full File Operations**: Create, read, update, delete, and rename files and folders on the remote server.
- **Seamless Editing**: Open and edit remote files directly in VS Code, just like local files.
- **Context Menus**: Right-click on files and folders for quick access to all file operations.

## Installation

1. Open Visual Studio Code.
2. Go to the Extensions view (`Ctrl+Shift+X`).
3. Search for "Jupyter File Explorer" and click **Install**.

## Usage

### Managing Connections

All connection commands can be accessed from the Command Palette (`Ctrl+Shift+P`):

1.  **`Jupyter: Add New Jupyter Connection`**: Prompts you to enter a name, URL, token, and remote path for a new server connection.
2.  **`Jupyter: Select Jupyter Connection`**: Shows a list of your saved connections, allowing you to switch the explorer to a different server.
3.  **`Jupyter: Remove Jupyter Connection`**: Shows a list of your saved connections to choose one to remove.

### Exploring Files

- Once a connection is selected, the **Jupyter Files** explorer view will appear in the sidebar, showing the remote file structure.
- Use the **Refresh** icon in the view's title bar to reload the file list.
- Use the **New File** and **New Folder** icons to create items at the root of your connected path.
- Right-click on any file or folder to open, rename, or delete it.

## Configuration

Your server connections are stored in your VS Code `settings.json` file. You can edit this file directly for advanced configuration.

The configuration is stored under the `jupyterFileExplorer.connections` property:

```json
"jupyterFileExplorer.connections": [
    {
        "name": "My Dev Server",
        "url": "http://localhost:8888/",
        "token": "your-secret-token",
        "remotePath": "projects/"
    },
    {
        "name": "JupyterHub Prod",
        "url": "https://my-jupyterhub.com/",
        "token": "another-token",
        "remotePath": "user/my-username/lab"
    }
]
```

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

