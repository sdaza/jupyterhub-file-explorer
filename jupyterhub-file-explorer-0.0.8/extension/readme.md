# JupyterHub File Explorer

JupyterHub File Explorer is a Visual Studio Code extension that allows you to browse and manage files on a remote Jupyter Server directly from your VS Code environment.

## Features

- **Intuitive Connection Management**: A clear connect/disconnect flow with a welcome screen to guide you.
- **Save Multiple Connections**: Save and quickly switch between multiple Jupyter Server configurations.
- **Full File Operations**: Create, read, update, delete, and rename files and folders on the remote server.
- **Seamless Editing**: Open and edit remote files directly in VS Code.
- **Context-Aware UI**: Buttons and menus appear only when they are relevant.

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

- Once connected, the file explorer will show the contents of your remote path.
- **View Title Bar**:
    - **Disconnect**: Disconnects from the current server.
    - **Refresh**: Reloads the file and folder list.
    - **New File**: Creates a new file in the root directory.
    - **New Folder**: Creates a new folder in the root directory.
- **Context Menus**: Right-click on a file or folder to access actions like `New File`, `New Folder`, `Rename`, and `Delete`.

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

This project is licensed under the MIT License - see the [LICENSE.md](https://github.com/sdaza/jupyterhub-file-explorer/blob/HEAD/LICENSE.md) file for details.

