import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { FileType, FileInfo, determineFileTypeFromPath, ProjectStructure } from './projectScanner.js';

// Convert fs methods to promise-based
const readFile = promisify(fs.readFile);

// Types of relationships between files
export enum DependencyType {
    Import = 'import',       // File imports another file
    Export = 'export',       // File exports to another file
    Reference = 'reference', // File references another file (e.g. via types)
    Usage = 'usage',         // File uses content from another file
    StyleImport = 'style',   // CSS/SCSS import
    HtmlLink = 'html-link',  // HTML file links to another file
    Unknown = 'unknown'      // Relationship can't be determined
}

// Dependency relationship between two files
export interface Dependency {
    source: string;           // Path of the source file
    target: string;           // Path of the target/dependency file
    type: DependencyType;     // Type of dependency relationship
    lineNumbers?: number[];   // Line numbers where dependency is referenced (optional)
    isExternal: boolean;      // Whether the dependency is external (e.g. node_modules)
}

// Graph representation of project dependencies
export interface DependencyGraph {
    nodes: Map<string, FileInfo>;                 // Files in the project
    edges: Map<string, Map<string, Dependency>>;  // Dependencies between files
}

export class DependencyManager {
    private workspaceRoot: string | undefined;

    // Cache dependencies for performance
    private dependencyCache: Map<string, Dependency[]> = new Map();

    // External package patterns
    private externalPackagePatterns: string[] = [
        'node_modules',
        // Add common CDN domains if the project imports from them
        'https://cdn',
        'http://cdn',
        'https://unpkg.com',
        'https://jsdelivr.com'
    ];

    constructor() {
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            this.workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        }
    }

    /**
     * Builds a dependency graph for the entire project
     * @param projectStructure Project structure from ProjectScanner
     * @param progressCallback Optional callback for reporting progress (0-100)
     * @returns Promise resolving to the complete dependency graph
     */
    public async buildDependencyGraph(
        projectStructure: ProjectStructure,
        progressCallback?: (progress: number) => void
    ): Promise<DependencyGraph> {
        const graph: DependencyGraph = {
            nodes: new Map(),
            edges: new Map()
        };

        // Add all files to nodes
        for (const file of projectStructure.allFiles) {
            graph.nodes.set(file.path, file);
            graph.edges.set(file.path, new Map());
        }

        // Process each file to find dependencies
        const totalFiles = projectStructure.allFiles.length;
        let processedFiles = 0;

        for (const file of projectStructure.allFiles) {
            // Get dependencies for this file
            const dependencies = await this.analyzeDependencies(file);

            // Add dependencies to the graph
            for (const dep of dependencies) {
                // If the target exists in our project, add it as an edge
                if (graph.nodes.has(dep.target)) {
                    graph.edges.get(file.path)?.set(dep.target, dep);
                }
            }

            // Report progress
            processedFiles++;
            if (progressCallback) {
                progressCallback((processedFiles / totalFiles) * 100);
            }
        }

        return graph;
    }

    /**
     * Analyzes a file to find its dependencies
     * @param file File to analyze
     * @returns Promise resolving to array of dependencies
     */
    public async analyzeDependencies(file: FileInfo): Promise<Dependency[]> {
        // Check cache first
        if (this.dependencyCache.has(file.path)) {
            return this.dependencyCache.get(file.path)!;
        }

        const dependencies: Dependency[] = [];

        // Skip if file is too large or binary
        if (file.size > 1024 * 1024 || this.isBinaryFile(file)) {
            this.dependencyCache.set(file.path, dependencies);
            return dependencies;
        }

        // Load content if not already loaded
        let content: string;
        if (file.content) {
            content = file.content;
        } else {
            try {
                content = await readFile(file.path, 'utf-8');
            } catch (error) {
                console.error(`Error reading file ${file.path}:`, error);
                this.dependencyCache.set(file.path, dependencies);
                return dependencies;
            }
        }

        // Extract dependencies based on file type
        switch (file.type) {
            case FileType.JavaScript:
            case FileType.TypeScript:
                this.extractJavaScriptDependencies(file.path, content, dependencies);
                break;
            case FileType.HTML:
                this.extractHTMLDependencies(file.path, content, dependencies);
                break;
            case FileType.CSS:
                this.extractCSSDependencies(file.path, content, dependencies);
                break;
            case FileType.JSON:
                this.extractJSONDependencies(file.path, content, dependencies);
                break;
            case FileType.Markdown:
                this.extractMarkdownDependencies(file.path, content, dependencies);
                break;
            // Add more file types as needed
        }

        // Cache the results
        this.dependencyCache.set(file.path, dependencies);

        return dependencies;
    }

    /**
     * Extracts dependencies from JavaScript/TypeScript files
     * @param filePath Path of the file
     * @param content Content of the file
     * @param dependencies Array to collect dependencies into
     */
    private extractJavaScriptDependencies(
        filePath: string,
        content: string,
        dependencies: Dependency[]
    ): void {
        // Extract import statements
        const importMatches = [...content.matchAll(/import\s+(?:(?:\{[^}]*\}|\*|[\w$]+)(?:\s+as\s+[\w$]+)?)?(?:\s*,\s*(?:\{[^}]*\}|\*|[\w$]+)(?:\s+as\s+[\w$]+)?)?(?:\s*,\s*(?:\{[^}]*\}|\*|[\w$]+)(?:\s+as\s+[\w$]+)?)?(?:\s+from)?\s+['"]([^'"]+)['"]/g)];

        // Extract require statements
        const requireMatches = [...content.matchAll(/(?:const|let|var)\s+(?:[\w$]+|\{[^}]*\})\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)];

        // Extract dynamic imports
        const dynamicImportMatches = [...content.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)];

        // Extract triple slash directives (TypeScript)
        const referenceMatches = [...content.matchAll(/\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]\s*\/>/g)];

        // Process each import match
        for (const match of [...importMatches, ...requireMatches, ...dynamicImportMatches]) {
            const importPath = match[1];

            // Determine if this is an external dependency
            const isExternal = this.isExternalDependency(importPath);

            // Skip node_modules dependencies since we can't analyze them directly
            if (isExternal && !this.shouldProcessExternalDependency(importPath)) {
                continue;
            }

            // Convert import path to absolute path if it's relative
            const targetPath = this.resolveImportPath(filePath, importPath);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.Import,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal
            });
        }

        // Process reference directives (TypeScript)
        for (const match of referenceMatches) {
            const referencePath = match[1];

            // Convert reference path to absolute path
            const targetPath = this.resolveImportPath(filePath, referencePath);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.Reference,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal: false // References are always local
            });
        }
    }

    /**
     * Extracts dependencies from HTML files
     * @param filePath Path of the file
     * @param content Content of the file
     * @param dependencies Array to collect dependencies into
     */
    private extractHTMLDependencies(
        filePath: string,
        content: string,
        dependencies: Dependency[]
    ): void {
        // Extract script tags
        const scriptMatches = [...content.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/g)];

        // Extract link tags (stylesheets)
        const linkMatches = [...content.matchAll(/<link[^>]*href=["']([^"']+)["'][^>]*>/g)];

        // Extract image tags
        const imgMatches = [...content.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/g)];

        // Process script tags
        for (const match of scriptMatches) {
            const src = match[1];

            // Skip data URLs and absolute URLs
            if (src.startsWith('data:') || (src.startsWith('http') && !this.shouldProcessExternalDependency(src))) {
                continue;
            }

            // Convert to absolute path
            const targetPath = this.resolveImportPath(filePath, src);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.HtmlLink,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal: this.isExternalDependency(src)
            });
        }

        // Process link tags
        for (const match of linkMatches) {
            const href = match[1];

            // Skip data URLs and absolute URLs
            if (href.startsWith('data:') || (href.startsWith('http') && !this.shouldProcessExternalDependency(href))) {
                continue;
            }

            // Convert to absolute path
            const targetPath = this.resolveImportPath(filePath, href);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.HtmlLink,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal: this.isExternalDependency(href)
            });
        }

        // Process image tags
        for (const match of imgMatches) {
            const src = match[1];

            // Skip data URLs and absolute URLs
            if (src.startsWith('data:') || (src.startsWith('http') && !this.shouldProcessExternalDependency(src))) {
                continue;
            }

            // Convert to absolute path
            const targetPath = this.resolveImportPath(filePath, src);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.HtmlLink,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal: this.isExternalDependency(src)
            });
        }
    }

    /**
     * Extracts dependencies from CSS files
     * @param filePath Path of the file
     * @param content Content of the file
     * @param dependencies Array to collect dependencies into
     */
    private extractCSSDependencies(
        filePath: string,
        content: string,
        dependencies: Dependency[]
    ): void {
        // Extract @import statements
        const importMatches = [...content.matchAll(/@import\s+(?:url\()?["']([^"']+)["'](?:\))?/g)];

        // Extract url() references
        const urlMatches = [...content.matchAll(/url\(["']?([^"')]+)["']?\)/g)];

        // Process @import statements
        for (const match of importMatches) {
            const importPath = match[1];

            // Skip http URLs and data URLs
            if ((importPath.startsWith('http') && !this.shouldProcessExternalDependency(importPath)) ||
                importPath.startsWith('data:')) {
                continue;
            }

            // Convert to absolute path
            const targetPath = this.resolveImportPath(filePath, importPath);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.StyleImport,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal: this.isExternalDependency(importPath)
            });
        }

        // Process url() references
        for (const match of urlMatches) {
            const urlPath = match[1];

            // Skip http URLs, data URLs, and hash references
            if (urlPath.startsWith('http') || urlPath.startsWith('data:') || urlPath.startsWith('#')) {
                continue;
            }

            // Convert to absolute path
            const targetPath = this.resolveImportPath(filePath, urlPath);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.StyleImport,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal: this.isExternalDependency(urlPath)
            });
        }
    }

    /**
     * Extracts dependencies from JSON files
     * @param filePath Path of the file
     * @param content Content of the file
     * @param dependencies Array to collect dependencies into
     */
    private extractJSONDependencies(
        filePath: string,
        content: string,
        dependencies: Dependency[]
    ): void {
        // Only process package.json files
        if (!filePath.endsWith('package.json')) {
            return;
        }

        try {
            const packageJson = JSON.parse(content);

            // Track dependencies
            const dependencySections = [
                'dependencies',
                'devDependencies',
                'peerDependencies',
                'optionalDependencies'
            ];

            for (const section of dependencySections) {
                if (packageJson[section]) {
                    for (const [pkg, version] of Object.entries(packageJson[section])) {
                        dependencies.push({
                            source: filePath,
                            target: `node_modules/${pkg}`,
                            type: DependencyType.Import,
                            isExternal: true
                        });
                    }
                }
            }
        } catch (error) {
            console.error(`Error parsing JSON in ${filePath}:`, error);
        }
    }

    /**
     * Extracts dependencies from Markdown files
     * @param filePath Path of the file
     * @param content Content of the file
     * @param dependencies Array to collect dependencies into
     */
    private extractMarkdownDependencies(
        filePath: string,
        content: string,
        dependencies: Dependency[]
    ): void {
        // Extract image references
        const imageMatches = [...content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];

        // Extract link references
        const linkMatches = [...content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];

        // Process image references
        for (const match of imageMatches) {
            const imagePath = match[2];

            // Skip http URLs
            if (imagePath.startsWith('http')) {
                continue;
            }

            // Convert to absolute path
            const targetPath = this.resolveImportPath(filePath, imagePath);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.Reference,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal: false
            });
        }

        // Process local links
        for (const match of linkMatches) {
            const linkPath = match[2];

            // Skip http URLs, anchors and email links
            if (linkPath.startsWith('http') || linkPath.startsWith('#') || linkPath.includes('@')) {
                continue;
            }

            // Convert to absolute path
            const targetPath = this.resolveImportPath(filePath, linkPath);

            // Add to dependencies
            dependencies.push({
                source: filePath,
                target: targetPath,
                type: DependencyType.Reference,
                lineNumbers: this.findLineNumbers(content, match[0]),
                isExternal: false
            });
        }
    }

    /**
     * Resolves an import path to an absolute path
     * @param sourcePath Path of the source file
     * @param importPath Import path to resolve
     * @returns Resolved absolute path
     */
    private resolveImportPath(sourcePath: string, importPath: string): string {
        // If import path is absolute or external, return as is
        if (importPath.startsWith('/') || importPath.startsWith('http')) {
            if (importPath.startsWith('/') && this.workspaceRoot) {
                // Resolve absolute workspace paths
                return path.join(this.workspaceRoot, importPath);
            }
            return importPath;
        }

        // For relative imports, resolve based on the source file's directory
        const sourceDir = path.dirname(sourcePath);
        let resolvedPath = path.resolve(sourceDir, importPath);

        // Handle the case where extension is not provided
        if (!path.extname(resolvedPath)) {
            // Try common extensions
            const extensions = ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.scss', '.html', '.md'];

            for (const ext of extensions) {
                const pathWithExt = resolvedPath + ext;
                if (fs.existsSync(pathWithExt)) {
                    return pathWithExt;
                }
            }

            // Check for index files
            for (const ext of extensions) {
                const indexPath = path.join(resolvedPath, `index${ext}`);
                if (fs.existsSync(indexPath)) {
                    return indexPath;
                }
            }
        }

        return resolvedPath;
    }

    /**
     * Checks if a dependency is external
     * @param importPath Import path to check
     * @returns True if the dependency is external
     */
    private isExternalDependency(importPath: string): boolean {
        // Check against external patterns
        for (const pattern of this.externalPackagePatterns) {
            if (importPath.includes(pattern)) {
                return true;
            }
        }

        // Check if it's a relative or absolute path
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
            return false;
        }

        // If not relative/absolute and not a known external pattern, 
        // it's likely an npm package
        return true;
    }

    /**
     * Determines if we should process an external dependency
     * @param path Path to check
     * @returns True if we should process this external dependency
     */
    private shouldProcessExternalDependency(path: string): boolean {
        // For simplicity, don't process most external dependencies
        // Could add specific CDNs or dependencies to process here
        return false;
    }

    /**
     * Checks if a file is likely binary
     * @param file File to check
     * @returns True if the file is likely binary
     */
    private isBinaryFile(file: FileInfo): boolean {
        if (file.type === FileType.Image) {
            return true;
        }

        // List of binary extensions
        const binaryExtensions = [
            '.pdf', '.zip', '.gz', '.tar',
            '.exe', '.dll', '.so', '.dylib',
            '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico',
            '.mp3', '.mp4', '.wav', '.avi', '.mkv',
            '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
        ];

        return binaryExtensions.includes(file.extension);
    }

    /**
     * Finds line numbers where a pattern appears in content
     * @param content Content to search in
     * @param pattern Pattern to search for
     * @returns Array of line numbers (0-based)
     */
    private findLineNumbers(content: string, pattern: string): number[] {
        const lines = content.split('\n');
        const lineNumbers: number[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(pattern)) {
                lineNumbers.push(i);
            }
        }

        return lineNumbers;
    }

    /**
     * Gets the dependencies for a specific file
     * @param filePath Path to the file
     * @param recursive Whether to recursively include dependencies of dependencies
     * @param maxDepth Maximum recursion depth
     * @returns Promise resolving to an array of dependencies
     */
    public async getFileDependencies(
        filePath: string,
        recursive: boolean = false,
        maxDepth: number = 3
    ): Promise<Dependency[]> {
        // Ensure path is absolute
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workspaceRoot!, filePath);

        // Get basic file info
        const fileStats = await promisify(fs.stat)(absolutePath);
        const fileName = path.basename(absolutePath);
        const extension = path.extname(absolutePath).toLowerCase();

        const fileInfo: FileInfo = {
            path: absolutePath,
            relativePath: this.workspaceRoot ? path.relative(this.workspaceRoot, absolutePath) : absolutePath,
            name: fileName,
            extension: extension,
            type: determineFileTypeFromPath(filePath)
            ,
            size: fileStats.size,
            lastModified: fileStats.mtime
        };

        // Get direct dependencies
        const directDependencies = await this.analyzeDependencies(fileInfo);

        // If not recursive, return direct dependencies only
        if (!recursive || maxDepth <= 0) {
            return directDependencies;
        }

        // For recursive dependencies, process each direct dependency
        const allDependencies = [...directDependencies];
        const processedPaths = new Set<string>([absolutePath]);

        // Process each direct dependency recursively
        for (const dep of directDependencies) {
            // Skip if already processed or external
            if (processedPaths.has(dep.target) || dep.isExternal) {
                continue;
            }

            processedPaths.add(dep.target);

            // Get recursive dependencies
            const recursiveDeps = await this.getFileDependencies(
                dep.target,
                true,
                maxDepth - 1
            );

            // Add unique dependencies
            for (const recursiveDep of recursiveDeps) {
                if (!allDependencies.some(d =>
                    d.source === recursiveDep.source &&
                    d.target === recursiveDep.target
                )) {
                    allDependencies.push(recursiveDep);
                }
            }
        }

        return allDependencies;
    }

    /**
     * Gets files that depend on a specific file
     * @param filePath Path to the file
     * @param projectStructure Project structure from ProjectScanner
     * @returns Promise resolving to array of dependent file paths
     */
    public async getFileReverseDependencies(
        filePath: string,
        projectStructure: ProjectStructure
    ): Promise<string[]> {
        // Ensure path is absolute
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workspaceRoot!, filePath);

        const dependents: string[] = [];

        // Scan all files for dependencies on the target file
        for (const file of projectStructure.allFiles) {
            const dependencies = await this.analyzeDependencies(file);

            // Check if any dependency targets our file
            if (dependencies.some(dep => dep.target === absolutePath)) {
                dependents.push(file.path);
            }
        }

        return dependents;
    }

    /**
     * Finds circular dependencies in the project
     * @param dependencyGraph Dependency graph from buildDependencyGraph
     * @returns Array of circular dependency chains
     */
    public findCircularDependencies(dependencyGraph: DependencyGraph): string[][] {
        const circularDependencies: string[][] = [];

        // For each node, perform a depth-first search to find cycles
        for (const startNode of dependencyGraph.nodes.keys()) {
            const visited = new Set<string>();
            const path: string[] = [];

            this.dfsForCycles(
                startNode,
                dependencyGraph,
                visited,
                path,
                circularDependencies
            );
        }

        return circularDependencies;
    }

    /**
     * Performs depth-first search to find cycles in the dependency graph
     * @param current Current node
     * @param graph Dependency graph
     * @param visited Set of visited nodes
     * @param path Current path
     * @param cycles Array to collect cycles into
     */
    private dfsForCycles(
        current: string,
        graph: DependencyGraph,
        visited: Set<string>,
        path: string[],
        cycles: string[][]
    ): void {
        // If we've already completely processed this node, skip it
        if (visited.has(current)) {
            return;
        }

        // If this node is already in the current path, we've found a cycle
        const cycleIndex = path.indexOf(current);
        if (cycleIndex !== -1) {
            // Extract the cycle
            const cycle = path.slice(cycleIndex).concat(current);

            // Check if this cycle is already recorded
            const isCycleRecorded = cycles.some(recordedCycle => {
                if (recordedCycle.length !== cycle.length) {
                    return false;
                }

                // Check if it's the same cycle regardless of rotation
                for (let i = 0; i < recordedCycle.length; i++) {
                    let match = true;
                    for (let j = 0; j < recordedCycle.length; j++) {
                        if (recordedCycle[j] !== cycle[(i + j) % cycle.length]) {
                            match = false;
                            break;
                        }
                    }
                    if (match) {
                        return true;
                    }
                }

                return false;
            });

            if (!isCycleRecorded) {
                cycles.push(cycle);
            }

            return;
        }

        // Add current node to path
        path.push(current);

        // Visit all dependencies
        const dependencies = graph.edges.get(current);
        if (dependencies) {
            for (const [target, _] of dependencies) {
                this.dfsForCycles(target, graph, visited, [...path], cycles);
            }
        }

        // Mark this node as completely visited
        visited.add(current);
    }

    /**
     * Generates a summary of dependencies for a file
     * @param filePath Path to the file
     * @returns Promise resolving to dependency summary
     */
    public async generateDependencySummary(filePath: string): Promise<string> {
        // Ensure path is absolute
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workspaceRoot!, filePath);

        // Get direct dependencies
        const fileStats = await promisify(fs.stat)(absolutePath);
        const fileName = path.basename(absolutePath);
        const extension = path.extname(absolutePath).toLowerCase();

        const fileInfo: FileInfo = {
            path: absolutePath,
            relativePath: this.workspaceRoot ? path.relative(this.workspaceRoot, absolutePath) : absolutePath,
            name: fileName,
            extension: extension,
            type: determineFileTypeFromPath(extension),
            size: fileStats.size,
            lastModified: fileStats.mtime
        };

        const dependencies = await this.analyzeDependencies(fileInfo);

        // Group dependencies by type
        const dependenciesByType = new Map<DependencyType, Dependency[]>();
        for (const dep of dependencies) {
            if (!dependenciesByType.has(dep.type)) {
                dependenciesByType.set(dep.type, []);
            }
            dependenciesByType.get(dep.type)!.push(dep);
        }

        // Generate summary
        let summary = `Dependency Summary for ${path.basename(filePath)}:\n\n`;

        // Add dependencies by type
        for (const [type, deps] of dependenciesByType.entries()) {
            summary += `${type} Dependencies (${deps.length}):\n`;

            // Group by external/internal
            const external = deps.filter(d => d.isExternal);
            const internal = deps.filter(d => !d.isExternal);

            if (internal.length > 0) {
                summary += `  Internal:\n`;
                for (const dep of internal) {
                    const relativePath = this.workspaceRoot
                        ? path.relative(this.workspaceRoot, dep.target)
                        : dep.target;

                    summary += `    - ${relativePath}`;

                    if (dep.lineNumbers && dep.lineNumbers.length > 0) {
                        summary += ` (line${dep.lineNumbers.length > 1 ? 's' : ''} ${dep.lineNumbers.map(n => n + 1).join(', ')})`;
                    }
                    summary += '\n';
                }
            }

            if (external.length > 0) {
                summary += `  External:\n`;
                for (const dep of external) {
                    summary += `    - ${dep.target}`;
                    if (dep.lineNumbers && dep.lineNumbers.length > 0) {
                        summary += ` (line${dep.lineNumbers.length > 1 ? 's' : ''} ${dep.lineNumbers.map(n => n + 1).join(', ')})`;
                    }
                    summary += '\n';
                }
            }

            summary += '\n';
        }

        // Add circular dependency check
        const graph = await this.buildDependencyGraph({
            workspaceRoot: this.workspaceRoot || '',
            rootDirectories: [],
            rootFiles: [],
            allFiles: [fileInfo]
        });

        const circularDeps = this.findCircularDependencies(graph);
        if (circularDeps.length > 0) {
            summary += '\n⚠️ Circular Dependencies Found:\n';
            for (const cycle of circularDeps) {
                const relativeCycle = cycle.map(p =>
                    this.workspaceRoot ? path.relative(this.workspaceRoot, p) : p
                );
                summary += `↻ ${relativeCycle.join(' → ')}\n`;
            }
        }

        return summary;
    }
}