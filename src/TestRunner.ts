import { spawn, ChildProcess } from 'child_process';
import { window, workspace, FileSystemWatcher, RelativePattern } from 'vscode';
const debounce = require('lodash.debounce');
const kill = require('tree-kill');

import { NodeTDD } from './NodeTDD';
import { messages, config } from './constants';
import { parseCoverage, readFileAsync } from './utils';

export class TestRunner {
    private fsWatcher: FileSystemWatcher | null = null;
    private process: ChildProcess | null = null;

    watch() {
        const buildOnCreate = NodeTDD.getConfig<boolean>(config.BUILD_ON_CREATE);
        const buildOnDelete = NodeTDD.getConfig<boolean>(config.BUILD_ON_DELETE);

        if (!this.fsWatcher) {
            // It's safe to assume workspace.workspaceFolders to exist,
            // because it has been checked already before calling watch()
            const globPath = new RelativePattern(
                workspace.workspaceFolders![0], NodeTDD.getConfig<string>(config.GLOB));

            this.fsWatcher = workspace.createFileSystemWatcher(
                globPath, !buildOnCreate, false, !buildOnDelete);
        }

        this.fsWatcher.onDidChange(debounce(this.run.bind(this), config.DEBOUNCE_WAIT_TIME));

        if (buildOnCreate) {
            this.fsWatcher.onDidCreate(debounce(this.run.bind(this), config.DEBOUNCE_WAIT_TIME));
        }

        if (buildOnDelete) {
            this.fsWatcher.onDidDelete(debounce(this.run.bind(this), config.DEBOUNCE_WAIT_TIME));
        }

        if (NodeTDD.getConfig<boolean>(config.BUILD_ON_ACTIVATION)) {
            this.run();
        }
    }

    stop() {
        if (this.process) {
            kill(this.process.pid, 'SIGKILL');
        }
    }

    dispose() {
        this.stop();

        if (this.fsWatcher) {
            this.fsWatcher.dispose();
            this.fsWatcher = null;
        }
    }

    private get testCommand() {
        const scriptName = NodeTDD.getConfig<string>(config.TEST_SCRIPT).trim();

        return scriptName === 'test' ? [scriptName] : ['run', scriptName];
    }

    private async run() {
        if (this.process) {
            return;
        }

        let packageObj;

        try {
            const packageJSON = await readFileAsync(workspace.rootPath + '/package.json');

            packageObj = JSON.parse(packageJSON);
        }
        catch (err) {
            const selection = await window.showErrorMessage(
                messages.PACKAGE_JSON_NOT_FOUND, messages.DEACTIVATE_DIALOG);

            if (selection === messages.DEACTIVATE_DIALOG) {
                NodeTDD.getInstance().deactivate();
            }

            return;
        }

        const scriptName = NodeTDD.getConfig<string>(config.TEST_SCRIPT).trim();

        if (!packageObj.scripts[scriptName]) {
            const selection = await window.showErrorMessage(
                messages.scriptNotFound(scriptName), messages.OPEN_PACKAGE_JSON);

            if (selection === messages.OPEN_PACKAGE_JSON) {
                workspace.openTextDocument(workspace.rootPath + '/package.json')
                    .then(textDocument => {

                        window.showTextDocument(textDocument);
                    });
            }

            return;
        }

        NodeTDD.getInstance().clearOutput();
        NodeTDD.getInstance().clearCoverage();
        NodeTDD.getInstance().hideCoverageStatusBar();

        const minimal = NodeTDD.getConfig<boolean>(config.MINIMAL);

        if (minimal) {
            NodeTDD.getInstance().setBuildStatusBar(messages.building(minimal));
        } else {
            NodeTDD.getInstance().setBuildStatusBar({
                ...messages.building(minimal),
                text: messages.building(minimal).text + ' '.repeat(4)
            });
        }

        NodeTDD.getInstance().showBuildStatusBar();

        this.execProcess(clearInterval.bind(null, this.animateBuilding()));
    }

    private animateBuilding() {
        let count = 1;

        const minimal = NodeTDD.getConfig<boolean>(config.MINIMAL);

        if (minimal) {
            return setInterval(() => {
                count += 1;
                const alpha = count % 2 === 0 ? 0 : 1;

                NodeTDD.getInstance().setBuildStatusBar({
                    text: messages.building(minimal).text,
                    color: `rgba(255, 255, 255, ${alpha})`
                });
            }, config.BUILDING_ANIMATION_SPEED * 2);
        }

        return setInterval(() => {

            const dots = count++ % 4;
            const spaces = 4 - dots;

            NodeTDD.getInstance().setBuildStatusBar({
                text: messages.building(minimal).text + '.'.repeat(dots) + ' '.repeat(spaces)
            });
        }, config.BUILDING_ANIMATION_SPEED);
    }

    private execProcess(callback: Function) {
        let stdout = '';
        let coverageString = '';
        const showCoverage = NodeTDD.getConfig<boolean>(config.SHOW_COVERAGE);
        const reporter = NodeTDD.getConfig<string | null>(config.REPORTER);

        if (process.platform === 'win32') {
            this.process = spawn('npm', this.testCommand, { cwd: workspace.rootPath, shell: process.env['comspec'] });
        } else {
            this.process = spawn('npm', this.testCommand, { cwd: workspace.rootPath, detached: true });
        }

        this.process.unref();

        this.process.stdout.on('data', (chunk) => {

            if (showCoverage) {
                if (chunk.toString().toLowerCase().includes('%')) {
                    coverageString += chunk.toString();
                }
            }

            const chunkStr = chunk.toString();
            NodeTDD.getInstance().appendOutput(chunkStr);

            if (reporter) {
                stdout += chunkStr;
            }
        });

        this.process.stderr.on('data', (chunk) => {

            NodeTDD.getInstance().appendOutput(chunk.toString());
        });

        this.process.on('close', async (code, signal) => {

            callback();
            this.process = null;

            const minimal = NodeTDD.getConfig<boolean>(config.MINIMAL);

            let report;

            if (reporter) {
                report = {
                    reporter,
                    stdout
                };
            }

            if (signal) {
                NodeTDD.getInstance().setBuildStatusBar(messages.buildStopped(minimal));
            }
            else if (code === 0) {
                NodeTDD.getInstance().setBuildStatusBar(await messages.passing(minimal, report));
            }
            else if (code === 1) {
                NodeTDD.getInstance().setBuildStatusBar(await messages.failing(minimal, report));
            }

            NodeTDD.getInstance().showInfoDialog(code);

            if (coverageString.length) {
                NodeTDD.getInstance().setCoverage(parseCoverage(coverageString));
                NodeTDD.getInstance().showCoverageStatusBar();
            }
        });
    }
}
