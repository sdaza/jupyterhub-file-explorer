# JupyterHub File Explorer

JupyterHub File Explorer is a Visual Studio Code extension that allows you to browse and manage files on a remote Jupyter Server directly from your VS Code environment.

## Features

- **Intuitive Connection Management**: A clear connect/disconnect flow with a welcome screen to guide you.
- **Save Multiple Connections**: Save and quickly switch between multiple Jupyter Server configurations.
- **Full File Operations**: Create, read, update, delete, and rename files and folders on the remote server.
  - **Enhanced Folder Deletion**: Automatically handles recursive deletion of folders containing files and subdirectories
  - **Smart Cleanup**: Detects and handles "directory not empty" errors with detailed logging for troubleshooting
- **Context-Aware File Creation**: Create files and folders either in the current directory (via context menu) or in the root directory (via toolbar).
- **Drag & Drop File Management**: 
  - Upload files from your OS by dragging them into the explorer
  - Move files and folders within the remote server by dragging them between directories
  - Support for multiple file selection and batch operations
- **Auto-Reconnect & Directory Memory**: Automatically reconnect on connection loss and remember last directory for each connection.
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
- **View Title Bar** (Toolbar Actions):
    - **Disconnect**: Disconnects from the current server.
    - **Refresh**: Reloads the file and folder list.
    - **New File in Root Directory**: Creates a new file in the root directory of your remote path.
    - **New Folder in Root Directory**: Creates a new folder in the root directory of your remote path.
    - **Upload File**: Upload files from your local machine to the root directory.
    - **Upload Folder**: Upload entire folders from your local machine to the root directory.
- **Context Menus** (Right-click Actions): 
    - **On directories**: Right-click on a directory to access actions:
        - **New File**: Creates a new file **within the selected directory**.
        - **New Folder**: Creates a new folder **within the selected directory**.
        - **Upload File**: Upload files **into the selected directory**.
        - **Upload Folder**: Upload folders **into the selected directory**.
        - **Rename**: Rename the selected directory.
        - **Delete**: Delete the selected directory.
    - **On files**: Right-click on a file to access actions:
        - **Download File**: Download the file to your local machine.
        - **Rename**: Rename the selected file.
        - **Delete**: Delete the selected file.

#### Upload & Download Features

The extension supports multiple ways to transfer files:

1. **Manual Upload**:
   - Use toolbar buttons to upload to root directory
   - Use context menu on directories to upload into specific folders
   - Support for both individual files and entire folder structures

2. **Drag & Drop Upload**:
   - **Drag files or folders** from your operating system directly into the JupyterHub file explorer
   - Drop onto directories to upload into that specific directory
   - Drop onto empty space to upload to the current directory
   - Supports multiple files and nested folder structures

3. **Internal File Movement**:
   - **Drag and drop files and folders within the explorer** to move them between directories
   - Drag files from one folder and drop onto another folder to move them
   - Supports moving multiple files at once by selecting them and dragging
   - Prevents moving directories into themselves or their subdirectories
   - Real-time feedback for successful or failed move operations

4. **Download**:
   - Right-click any file and select "Download File"
   - Choose where to save the file on your local machine

#### File Creation Behavior

The extension provides two different ways to create files and folders:

1. **Toolbar Buttons** (View Title Bar): Always create in the **root directory**
   - Use these when you want to add items to the top level of your remote path
   
2. **Context Menu** (Right-click): Create **within the selected directory**
   - Right-click on any directory to create files/folders inside it
   - This allows you to organize your files in the proper subdirectories

#### File Editing

- **Double-click** or **single-click** any file to open it for editing
- **Save your changes** using `Ctrl+S` (Windows/Linux) or `Cmd+S` (Mac) to sync back to the remote Jupyter Server

## Configuration

Your server connections are stored in your VS Code settings. You can manage them through the extension's UI or edit your `settings.json` file directly for advanced configuration.

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
        "name": "JupyterHub Production",
        "url": "https://my-jupyterhub.com/",
        "token": "another-token",
        "remotePath": "user/my-username/lab"
    }
]
```

### Connection Parameters

- **name**: A unique, descriptive name for your connection
- **url**: The base URL of your Jupyter Server or JupyterHub instance
- **token**: Your Jupyter authentication token
- **remotePath**: The remote directory path to browse (can be empty for root, or specify a subdirectory)

### Advanced Configuration Options

You can customize the extension's behavior through VS Code settings:

- **`jupyterFileExplorer.autoReconnect`** (default: `true`): Automatically attempt to reconnect when connection is lost
- **`jupyterFileExplorer.reconnectInterval`** (default: `5000`): Time in milliseconds between reconnection attempts  
- **`jupyterFileExplorer.maxReconnectAttempts`** (default: `3`): Maximum number of reconnection attempts before giving up
- **`jupyterFileExplorer.rememberLastDirectory`** (default: `true`): Remember the last opened directory for each connection

Example settings configuration:
```json
{
  "jupyterFileExplorer.autoReconnect": true,
  "jupyterFileExplorer.reconnectInterval": 3000,
  "jupyterFileExplorer.maxReconnectAttempts": 5,
  "jupyterFileExplorer.rememberLastDirectory": true
}
```

## Troubleshooting

### Common Issues

- **Connection Failed**: Verify your server URL, token, and that the Jupyter Server is running
- **Files Not Loading**: Check your remote path and ensure you have proper permissions
- **Can't Create Files**: Ensure you have write permissions in the target directory
- **Can't Delete Non-Empty Folders**: The extension now supports recursive deletion of folders with files. If deletion fails:
  - Check the VS Code Developer Console for detailed error logs
  - Ensure you have proper permissions to delete all files in the folder
  - Some Jupyter servers may have restrictions on deleting certain system files or hidden files
  - Try deleting individual files first if the folder contains many items
- **Auto-reconnect Not Working**: Check that `jupyterFileExplorer.autoReconnect` is enabled in your settings
- **Directory Not Remembered**: Ensure `jupyterFileExplorer.rememberLastDirectory` is enabled in your settings
- **Drag & Drop Not Working**: 
  - **For external files**: Make sure you're dragging files/folders from your operating system file manager
  - **For internal moves**: Make sure you're dragging files/folders within the JupyterHub explorer tree view
  - Try dropping directly onto a directory in the tree view
  - If drag & drop fails, use the upload buttons for external files or rename operations for moves as alternatives
  - Check the VS Code Developer Console (Help → Toggle Developer Tools) for debugging information
  - For internal moves, ensure you're not trying to move a directory into itself

### Auto-Reconnect Feature

The extension automatically attempts to reconnect when it detects connection issues such as:
- Network timeouts
- Server errors (500, 502, 503, 504)
- Authentication errors (401, 403)
- Connection refused errors

When auto-reconnect is triggered:
1. You'll see a notification about the reconnection attempt
2. The extension will retry up to the configured maximum attempts
3. If successful, you'll be notified and can continue working
4. If all attempts fail, you'll need to reconnect manually

### Getting Help

If you encounter issues:
1. Check the VS Code Output panel for detailed error messages
2. Verify your connection settings
3. Report issues on the [GitHub repository](https://github.com/sdaza/jupyterhub-file-explorer)

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

