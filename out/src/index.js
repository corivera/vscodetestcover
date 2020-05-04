"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const fs = require("fs");
const os = require("os");
const Mocha = require("mocha");
const iLibInstrument = require("istanbul-lib-instrument");
const iLibCoverage = require("istanbul-lib-coverage");
const iLibReport = require("istanbul-lib-report");
const iReports = require("istanbul-reports");
const iLibHook = require("istanbul-lib-hook");
const iLibSourceMaps = require("istanbul-lib-source-maps");
const glob = require("glob");
const decache_1 = require("decache");
let mocha = new Mocha({
    ui: 'tdd',
    useColors: true
});
let testOptions;
function configure(mochaOpts, testOpts) {
    mocha = new Mocha(mochaOpts);
    testOptions = testOpts;
}
exports.configure = configure;
function mkDirIfExists(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
}
class CoverageRunner {
    constructor(options, testsRoot, endRunCallback) {
        this.options = options;
        this.testsRoot = testsRoot;
        this.coverageVar = '$$cov_' + new Date().getTime() + '$$';
        if (!options.relativeSourcePath) {
            return endRunCallback('Error - relativeSourcePath must be defined for code coverage to work');
        }
    }
    setupCoverage() {
        // Set up Code Coverage, hooking require so that instrumented code is returned
        this.instrumenter = iLibInstrument.createInstrumenter({ coverageVariable: this.coverageVar });
        let sourceRoot = path.join(this.testsRoot, this.options.relativeSourcePath);
        // Glob source files
        let srcFiles = glob.sync('**/**.js', {
            ignore: this.options.ignorePatterns,
            cwd: sourceRoot
        });
        // Create a match function - taken from the run-with-cover.js in istanbul.
        let fileMap = {};
        srcFiles.forEach(file => {
            let fullPath = path.join(sourceRoot, file);
            // Windows paths are (normally) case insensitive so convert to lower case
            // since sometimes the paths returned by the glob and the require hooks
            // are different casings.
            if (os.platform() === 'win32') {
                fullPath = fullPath.toLocaleLowerCase();
            }
            fileMap[fullPath] = true;
            // On Windows, extension is loaded pre-test hooks and this mean we lose
            // our chance to hook the Require call. In order to instrument the code
            // we have to decache the JS file so on next load it gets instrumented.
            // This doesn't impact tests, but is a concern if we had some integration
            // tests that relied on VSCode accessing our module since there could be
            // some shared global state that we lose.
            decache_1.default(fullPath);
        });
        this.matchFn = function (file) {
            // Windows paths are (normally) case insensitive so convert to lower case
            // since sometimes the paths returned by the glob and the require hooks
            // are different casings.
            if (os.platform() === 'win32') {
                file = file.toLocaleLowerCase();
            }
            return fileMap[file];
        };
        this.matchFn.files = Object.keys(fileMap);
        // Hook up to the Require function so that when this is called, if any of our source files
        // are required, the instrumented version is pulled in instead. These instrumented versions
        // write to a global coverage variable with hit counts whenever they are accessed
        this.transformer = (code, options) => {
            // Try to find a .map file
            let map = undefined;
            try {
                map = JSON.parse(fs.readFileSync(`${options.filename}.map`).toString());
            }
            catch (err) {
                // missing source map...
            }
            return this.instrumenter.instrumentSync(code, options.filename, map);
        };
        let hookOpts = { verbose: false, extensions: ['.js'] };
        this.unhookRequire = iLibHook.hookRequire(this.matchFn, this.transformer, hookOpts);
        // initialize the global variable to stop mocha from complaining about leaks
        global[this.coverageVar] = {};
        // Hook the process exit event to handle reporting
        process.on('exit', () => {
            this.reportCoverage();
        });
    }
    /**
     * Writes a coverage report. Note that as this is called in the process exit callback, all calls must be synchronous.
     *
     * @returns {void}
     *
     * @memberOf CoverageRunner
     */
    reportCoverage() {
        this.unhookRequire();
        let cov;
        if (typeof global[this.coverageVar] === 'undefined' || Object.keys(global[this.coverageVar]).length === 0) {
            console.error('No coverage information was collected, exit without writing coverage information');
            return;
        }
        else {
            cov = global[this.coverageVar];
        }
        // TODO consider putting this under a conditional flag
        // Files that are not touched by code ran by the test runner is manually instrumented, to
        // illustrate the missing coverage.
        this.matchFn.files.forEach(file => {
            if (!cov[file]) {
                this.transformer(fs.readFileSync(file, 'utf-8'), { filename: file });
                // When instrumenting the code, istanbul will give each FunctionDeclaration a value of 1 in coverState.s,
                // presumably to compensate for function hoisting. We need to reset this, as the function was not hoisted,
                // as it was never loaded.
                Object.keys(this.instrumenter.fileCoverage.s).forEach(key => {
                    this.instrumenter.fileCoverage.s[key] = 0;
                });
                cov[file] = this.instrumenter.fileCoverage;
            }
        });
        // Convert the report to the mapped source files
        const mapStore = iLibSourceMaps.createSourceMapStore();
        const coverageMap = mapStore.transformCoverage(iLibCoverage.createCoverageMap(global[this.coverageVar])).map;
        // TODO Allow config of reporting directory with
        let reportingDir = path.join(this.testsRoot, this.options.relativeCoverageDir);
        let includePid = this.options.includePid;
        let pidExt = includePid ? ('-' + process.pid) : '', coverageFile = path.resolve(reportingDir, 'coverage' + pidExt + '.json');
        mkDirIfExists(reportingDir); // yes, do this again since some test runners could clean the dir initially created
        fs.writeFileSync(coverageFile, JSON.stringify(cov), 'utf8');
        const context = iLibReport.createContext({
            dir: reportingDir,
            coverageMap: coverageMap
        });
        const tree = context.getTree('flat');
        const reportTypes = (this.options.reports instanceof Array) ? this.options.reports : ['lcovonly'];
        // Cast to any since create only takes specific values but we don't know what the user passed in.
        // We'll let the lib error out if an invalid value is passed in.
        reportTypes.forEach(reportType => tree.visit(iReports.create(reportType), context));
    }
}
function readCoverOptions(testsRoot) {
    let coverConfigPath = path.join(testsRoot, testOptions.coverConfig);
    let coverConfig = undefined;
    if (fs.existsSync(coverConfigPath)) {
        let configContent = fs.readFileSync(coverConfigPath).toString();
        coverConfig = JSON.parse(configContent);
    }
    return coverConfig;
}
function run(testsRoot, clb) {
    // Read configuration for the coverage file
    let coverOptions = readCoverOptions(testsRoot);
    if (coverOptions && coverOptions.enabled) {
        // Setup coverage pre-test, including post-test hook to report
        let coverageRunner = new CoverageRunner(coverOptions, testsRoot, clb);
        coverageRunner.setupCoverage();
    }
    // Glob test files
    glob('**/**.test.js', { cwd: testsRoot }, function (error, files) {
        if (error) {
            return clb(error);
        }
        try {
            // Fill into Mocha
            files.forEach(function (f) {
                return mocha.addFile(path.join(testsRoot, f));
            });
            // Run the tests
            mocha.run((failureCount) => {
                clb(undefined, failureCount);
            });
        }
        catch (error) {
            return clb(error);
        }
    });
}
exports.run = run;

//# sourceMappingURL=index.js.map
