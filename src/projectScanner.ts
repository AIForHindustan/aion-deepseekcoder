import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';

// Convert fs methods to promise-based
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);
const readFile = promisify(fs.readFile);

// File types based on extensions
export enum FileType {
    JavaScript = 'javascript',
    TypeScript = 'typescript',
    HTML = 'html',
    CSS = 'css',
    JSON = 'json',
    Markdown = 'markdown',
    Image = 'image',
    Unknown = 'unknown'
}

// Structure representing a file in the workspace
export interface FileInfo {
    path: string;           // Full path to the file
    relativePath: string;   // Path relative to workspace root
    name: string;           // File name with extension
    extension: string;      // File extension
    type: FileType;         // Type of file
    size: number;           // Size in bytes
    lastModified: Date;     // Last modified date
    content?: string;       // File content (optional - only loaded when needed)
}

// Structure representing a directory in the workspace
export interface DirectoryInfo {
    path: string;           // Full path to the directory
    relativePath: string;   // Path relative to workspace root
    name: string;           // Directory name
    files: FileInfo[];      // Files in this directory
    directories: DirectoryInfo[]; // Subdirectories
}

// Complete project structure
export interface ProjectStructure {
    workspaceRoot: string;  // Root path of the workspace
    rootDirectories: DirectoryInfo[]; // Top-level directories
    rootFiles: FileInfo[];  // Top-level files
    allFiles: FileInfo[];   // Flat list of all files for easy access
}

// Filter criteria for files
export interface FilterCriteria {
    extensions?: string[];  // File extensions to include
    excludePatterns?: string[]; // Glob patterns to exclude
    maxSize?: number;       // Maximum file size in bytes
    modifiedSince?: Date;   // Only files modified since this date
}

export class ProjectScanner {
    private workspaceRoot: string | undefined;
    private excludedFolders: Set<string> = new Set([
        'node_modules', '.git', 'dist', 'out', 'build',
        'coverage', '.vscode-test', '.vscode'
    ]);
    private excludedFiles: Set<string> = new Set([
        'package-lock.json', 'yarn.lock', '*.log'
    ]);

    // Default file size limit (1MB)
    private DEFAULT_FILE_SIZE_LIMIT = 1024 * 1024;

    constructor() {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }
    }

    /**
     * Scans the entire workspace and builds a project structure
     * @param progressCallback Optional callback for reporting progress (0-100)
     * @returns Promise resolving to the complete project structure
     */
    public async scanWorkspace(
        progressCallback?: (progress: number) => void
    ): Promise<ProjectStructure> {
        if (!this.workspaceRoot) {
            throw new Error('No workspace folder is open');
        }

        const structure: ProjectStructure = {
            workspaceRoot: this.workspaceRoot,
            rootDirectories: [],
            rootFiles: [],
            allFiles: []
        };

        // Get entries in the root directory
        const entries = await readdir(this.workspaceRoot, { withFileTypes: true });

        // Track progress
        let processedCount = 0;
        const reportProgress = () => {
            processedCount++;
            if (progressCallback) {
                progressCallback((processedCount / entries.length) * 100);
            }
        };

        // Process each entry
        const processingPromises = entries.map(async (entry) => {
            const entryPath = path.join(this.workspaceRoot!, entry.name);

            // Skip excluded folders
            if (entry.isDirectory() && this.excludedFolders.has(entry.name)) {
                reportProgress();
                return;
            }

            // Skip excluded files
            if (entry.isFile() && this.shouldExcludeFile(entry.name)) {
                reportProgress();
                return;
            }

            if (entry.isDirectory()) {
                // Process directory
                const dirInfo = await this.scanDirectory(entryPath, entry.name, '');
                structure.rootDirectories.push(dirInfo);

                // Add all files from this directory to the flat list
                this.collectAllFiles(dirInfo, structure.allFiles);
            } else if (entry.isFile()) {
                // Process file
                const fileInfo = await this.getFileInfo(entryPath, '');
                structure.rootFiles.push(fileInfo);
                structure.allFiles.push(fileInfo);
            }

            reportProgress();
        });

        await Promise.all(processingPromises);

        return structure;
    }

    /**
     * Scans a directory and returns its structure
     * @param dirPath Full path to the directory
     * @param dirName Name of the directory
     * @param relativePath Path relative to workspace root
     * @returns Promise resolving to directory info
     */
    private async scanDirectory(
        dirPath: string,
        dirName: string,
        relativePath: string
    ): Promise<DirectoryInfo> {
        const dirRelativePath = path.join(relativePath, dirName);

        const dirInfo: DirectoryInfo = {
            path: dirPath,
            relativePath: dirRelativePath,
            name: dirName,
            files: [],
            directories: []
        };

        // Read directory contents
        const entries = await readdir(dirPath, { withFileTypes: true });

        // Process each entry
        const processingPromises = entries.map(async (entry) => {
            const entryPath = path.join(dirPath, entry.name);

            // Skip excluded folders
            if (entry.isDirectory() && this.excludedFolders.has(entry.name)) {
                return;
            }

            // Skip excluded files
            if (entry.isFile() && this.shouldExcludeFile(entry.name)) {
                return;
            }

            if (entry.isDirectory()) {
                // Recursively scan subdirectory
                const subDirInfo = await this.scanDirectory(
                    entryPath,
                    entry.name,
                    dirRelativePath
                );
                dirInfo.directories.push(subDirInfo);
            } else if (entry.isFile()) {
                // Get file info
                const fileInfo = await this.getFileInfo(entryPath, dirRelativePath);
                dirInfo.files.push(fileInfo);
            }
        });

        await Promise.all(processingPromises);

        return dirInfo;
    }

    /**
     * Gets detailed information about a file
     * @param filePath Full path to the file
     * @param relativeDirPath Relative path to the directory containing the file
     * @returns Promise resolving to file info
     */
    private async getFileInfo(filePath: string, relativeDirPath: string): Promise<FileInfo> {
        const fileStats = await stat(filePath);
        const fileName = path.basename(filePath);
        const extension = path.extname(filePath).toLowerCase();

        return {
            path: filePath,
            relativePath: path.join(relativeDirPath, fileName),
            name: fileName,
            extension: extension,
            type: this.determineFileType(extension),
            size: fileStats.size,
            lastModified: fileStats.mtime
        };
    }

    /**
     * Gets detailed information about a specific file by path
     * @param filePath Path to the file (absolute or relative to workspace)
     * @returns Promise resolving to file details
     */
    public async getFileDetails(filePath: string): Promise<FileInfo> {
        // Ensure path is absolute
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workspaceRoot!, filePath);

        // Get basic file info
        const fileName = path.basename(absolutePath);
        const dirPath = path.dirname(absolutePath);
        const relativePath = this.workspaceRoot
            ? path.relative(this.workspaceRoot, absolutePath)
            : absolutePath;
        const relativeDirPath = path.dirname(relativePath);

        const fileInfo = await this.getFileInfo(absolutePath, relativeDirPath);

        // Load file content
        try {
            // Only load if file is not too large
            if (fileInfo.size <= this.DEFAULT_FILE_SIZE_LIMIT) {
                const content = await readFile(absolutePath, 'utf-8');
                fileInfo.content = content;
            }
        } catch (error) {
            console.error(`Error reading file ${absolutePath}:`, error);
        }

        return fileInfo;
    }

    /**
     * Determines the file type based on extension
     * @param extension File extension
     * @returns FileType
     */
    private determineFileType(extension: string): FileType {
        switch (extension) {
            case '.js':
            case '.jsx':
            case '.mjs':
                return FileType.JavaScript;
            case '.ts':
            case '.tsx':
                return FileType.TypeScript;
            case '.html':
            case '.htm':
            case '.xhtml':
                return FileType.HTML;
            case '.css':
            case '.scss':
            case '.less':
                return FileType.CSS;
            case '.json':
                return FileType.JSON;
            case '.md':
            case '.markdown':
                return FileType.Markdown;
            case '.png':
            case '.jpg':
            case '.jpeg':
            case '.gif':
            case '.svg':
                return FileType.Image;
            default:
                return FileType.Unknown;
        }
    }

    /**
     * Checks if a file should be excluded based on its name
     * @param fileName File name to check
     * @returns True if file should be excluded
     */
    private shouldExcludeFile(fileName: string): boolean {
        for (const pattern of this.excludedFiles) {
            if (pattern.includes('*')) {
                // Simple glob handling for *.ext patterns
                const ext = pattern.replace('*', '');
                if (fileName.endsWith(ext)) {
                    return true;
                }
            } else if (pattern === fileName) {
                return true;
            }
        }
        return false;
    }

    /**
     * Collect all files from a directory structure into a flat list
     * @param dirInfo Directory info
     * @param allFiles Array to collect files into
     */
    private collectAllFiles(dirInfo: DirectoryInfo, allFiles: FileInfo[]): void {
        // Add files from this directory
        allFiles.push(...dirInfo.files);

        // Recursively add files from subdirectories
        for (const subDir of dirInfo.directories) {
            this.collectAllFiles(subDir, allFiles);
        }
    }

    /**
     * Filters files based on given criteria
     * @param criteria Filter criteria
     * @returns Array of file paths matching the criteria
     */
    public async filterFiles(criteria: FilterCriteria): Promise<string[]> {
        if (!this.workspaceRoot) {
            throw new Error('No workspace folder is open');
        }

        // First scan the workspace if we haven't already
        let structure: ProjectStructure;
        try {
            structure = await this.scanWorkspace();
        } catch (error) {
            console.error('Error scanning workspace:', error);
            throw error;
        }

        // Apply filters
        return structure.allFiles
            .filter(file => {
                // Filter by extension
                if (criteria.extensions && criteria.extensions.length > 0) {
                    if (!criteria.extensions.includes(file.extension)) {
                        return false;
                    }
                }

                // Filter by size
                if (criteria.maxSize !== undefined && file.size > criteria.maxSize) {
                    return false;
                }

                // Filter by modification date
                if (criteria.modifiedSince && file.lastModified < criteria.modifiedSince) {
                    return false;
                }

                // Filter by exclude patterns
                if (criteria.excludePatterns) {
                    for (const pattern of criteria.excludePatterns) {
                        // Simple glob handling
                        if (pattern.endsWith('*')) {
                            const prefix = pattern.slice(0, -1);
                            if (file.relativePath.startsWith(prefix)) {
                                return false;
                            }
                        } else if (pattern === file.relativePath) {
                            return false;
                        }
                    }
                }

                return true;
            })
            .map(file => file.path);
    }

}
export function determineFileTypeFromPath(filePath: string): FileType {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.js':
        case '.jsx':
        case '.mjs':
            return FileType.JavaScript;
        case '.ts':
        case '.tsx':
            return FileType.TypeScript;
        case '.html':
        case '.htm':
        case '.xhtml':
            return FileType.HTML;
        case '.css':
        case '.scss':
        case '.less':
            return FileType.CSS;
        case '.json':
            return FileType.JSON;
        case '.md':
        case '.markdown':
            return FileType.Markdown;
        case '.png':
        case '.jpg':
        case '.jpeg':
        case '.gif':
        case '.svg':
            return FileType.Image;
        default:
            return FileType.Unknown;
    }
}
