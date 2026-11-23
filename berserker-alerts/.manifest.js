'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IGNORED_FILES = [
    'manifest.json',
    'manifest-generator.js',
    'manifest-generator.bat',
    'manifest-generator.exe',
    'node.exe',
];
const IGNORED_START_SYMBOL = ['.', '_'];

// Read the settings file path from module.json and normalize it to the same
// relative, forward-slash format that is used for keys in manifest.files.
let settingsFile = undefined;
try {
    const moduleInfo = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'module.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
    const configuredSettingsFile =
        moduleInfo.options && moduleInfo.options.settingsFile !== undefined
            ? moduleInfo.options.settingsFile
            : (moduleInfo.settingsFile !== undefined ? moduleInfo.settingsFile : 'config.json');

    if (typeof configuredSettingsFile === 'string' && configuredSettingsFile.trim()) {
        const absoluteSettingsFile = path.resolve(__dirname, configuredSettingsFile);
        const relativeSettingsFile = path.relative(__dirname, absoluteSettingsFile);

        if (
            relativeSettingsFile.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativeSettingsFile)
        )
            throw new Error(
                `settingsFile points outside the module directory: ${configuredSettingsFile}`,
            );

        settingsFile = relativeSettingsFile.replace(/\\/g, '/');
    }
} catch (err) {
    throw new Error(`Unable to read settingsFile from module.json: ${err.message}`);
}

//load predefined manifest
let manifest = undefined;
try {
    manifest = require('./manifest.json');
    if (manifest && typeof manifest === 'object') {
        if (!manifest.files) manifest.files = {};
    } else manifest = { files: {} };
} catch (err) {
    manifest = { files: {} };
}

//cleanup manifest
Object.keys(manifest.files).forEach((entry) => {
    try {
        fs.accessSync(path.join(__dirname, entry), fs.constants.F_OK);
    } catch (err) {
        delete manifest.files[entry];
    }
});

//recursive file gather
function findInDirRelative(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
        const filePath = path.join(dir, file);
        const fileStat = fs.lstatSync(filePath);
        if (!IGNORED_FILES.includes(file) && !IGNORED_START_SYMBOL.includes(file[0])) {
            if (fileStat.isDirectory()) findInDirRelative(filePath, fileList);
            else fileList.push(path.relative(__dirname, filePath));
        }
    });
    return fileList;
}

//generate hash
const files = findInDirRelative(__dirname);
files.forEach((filePath) => {
    let file = filePath.replace(/\\/g, '/');
    const hash = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, file)))
        .digest('hex');
    if (file === settingsFile) {
        manifest.files[file] = {
            overwrite: false,
            hash: hash,
        };
    } else if (manifest.files[file] && typeof manifest.files[file] === 'object') {
        manifest.files[file].hash = hash;
    } else manifest.files[file] = hash;
});

if (settingsFile && !files.some((filePath) => filePath.replace(/\\/g, '/') === settingsFile))
    console.warn(`settingsFile does not exist and was not added to the manifest: ${settingsFile}`);

//save file
fs.writeFileSync(
    path.join(__dirname, 'manifest.json'),
    JSON.stringify(manifest, null, '\t'),
    'utf8',
);
