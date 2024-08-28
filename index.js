#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const prettier = require('prettier');
const dotenv = require('dotenv');
dotenv.config();
const tokens = require('gpt3-tokenizer').default;
const tokenizer = new tokens({ type: 'gpt3' });
const beautify = require("js-beautify/js").js;
const minify = require('html-minifier').minify;
const htmlbeautify = require("js-beautify/js").html;
const OpenAI = require("openai");
const { spawn } = require('child_process');

if (!process.env.OPENAI_API_KEY) {
    console.error('Please set OPENAI_API_KEY in a .env or environment variable.');
    process.exit(1);
}

const instarray = [...process.argv.slice(2)];

const transformationInstruction = instarray.join(' ');

const systemPrompt = `Perform the following changes: ${transformationInstruction}\nin the following application. Include all the modified or added files completely without comments. Reply only in code in this syntax #^filename&^filecontents#^filename&^filecontents`;

console.log({ prompt: transformationInstruction });

// Function to clone a GitHub repository
async function cloneGitHubRepo(repoUrl) {
    return new Promise((resolve, reject) => {
        const repoName = path.basename(repoUrl, '.git');
        if (fs.existsSync(repoName)) {
            console.log(`Repository ${repoName} already exists. Skipping clone.`);
            resolve(repoName);
            return;
        }
        const gitClone = spawn('git', ['clone', repoUrl]);

        gitClone.stdout.on('data', data => console.log(`stdout: ${data}`));
        gitClone.stderr.on('data', data => console.error(`stderr: ${data}`));
        gitClone.on('close', code => {
            if (code === 0) {
                console.log(`Repository ${repoName} cloned successfully.`);
                resolve(repoName);
            } else {
                reject(new Error(`Git clone failed with exit code ${code}`));
            }
        });
    });
}

async function processDirectory(directory) {
    const files = await fs.promises.readdir(directory);
    const fileDataPromises = files.map(async filename => {
        const filePath = path.join(directory, filename);
        if (filePath.startsWith('node_modules') || filePath.startsWith('.')) return null;
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
            return processDirectory(filePath);
        } else {
            return processFile(filePath);
        }
    });

    return (await Promise.all(fileDataPromises)).filter(Boolean);
}

async function processFile(filePath) {
    try {
        const fileContent = await fs.promises.readFile(filePath, 'utf8');
        let result;

        if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
            const Terser = require('terser');
            console.log('Minifying JS/JSX', { filePath });
            result = (await Terser.minify(fileContent, {
                mangle: false,
                compress: false,
                output: { comments: 'all' }
            })).code;
        } else if (filePath.endsWith('.json') && filePath !== 'package.json' && filePath !== 'package-lock.json') {
            console.log('Minifying JSON', { filePath });
            result = JSON.stringify(JSON.parse(fileContent));
        } else if (filePath.endsWith('.ejs') || filePath.endsWith('.html') || filePath.endsWith('.svelte')) {
            console.log('Minifying HTML', { filePath });
            const options = {
                includeAutoGeneratedTags: true,
                removeAttributeQuotes: true,
                removeRedundantAttributes: true,
                removeScriptTypeAttributes: true,
                removeStyleLinkTypeAttributes: true,
                sortClassName: true,
                useShortDoctype: true,
                collapseWhitespace: true,
                minifyJS: true
            };
            result = minify(fileContent, options);
        } else {
            return null; // Skip unsupported file types
        }

        return { filePath, result };
    } catch (error) {
        console.error(`Error processing ${filePath}:`, error);
        return null;
    }
}

async function generateJsonData() {
    try {
        let srcDirectory = './src'; // Default source directory path

        // Check if the transformation instruction contains a GitHub URL
        const githubUrlMatch = transformationInstruction.match(/https:\/\/github\.com\/[\w-]+\/[\w-]+\.git/);
        if (githubUrlMatch) {
            const repoUrl = githubUrlMatch[0];
            const repoName = await cloneGitHubRepo(repoUrl);
            srcDirectory = `./${repoName}`;
        }

        const fileData = await processDirectory(srcDirectory);
        const jsonEntries = fileData.reduce((acc, { filePath, result }) => {
            if (filePath && result) acc[filePath] = result;
            return acc;
        }, {});

        const generatedJsonData = Object.keys(jsonEntries)
            .map(a => `#^${a}&^${jsonEntries[a]}`)
            .join('');

        const message = `${generatedJsonData}`;
        const tokensCount = tokenizer.encode(`${transformationInstruction}${message}`).bpe.length + tokenizer.encode(systemPrompt).bpe.length + 15;

        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: `${message}\n\n${transformationInstruction}` }
        ];

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages,
            temperature: 0.2,
            max_tokens: 4096,
            top_p: 1.0,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
        });

        if (response.choices[0].finish_reason === 'length') {
            console.log("Response truncated due to length. Consider splitting the task.");
            return;
        }

        const text = response.choices[0].message.content.trim();
        fs.writeFileSync('transformed.out', text);
        return text;
    } catch (error) {
        console.error('Error generating JSON data:', error);
    }
}

function writeFilesFromStr(str) {
    const files = str.split('#^').slice(1);
    files.forEach(file => {
        const [filePath, fileContent] = file.split('&^');
        if (filePath && fileContent) writeFile(filePath, fileContent);
    });
}

function writeFile(filePath, content) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });

    if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) {
        content = beautify(content, { indent_size: 2, space_in_empty_paren: true });
    } else if (filePath.endsWith('.json')) {
        content = JSON.stringify(JSON.parse(content), null, 2);
    } else if (filePath.endsWith('.html') || filePath.endsWith('.ejs') || filePath.endsWith('.svelte')) {
        content = htmlbeautify(content, { indent_size: 2, preserve_newlines: true });
    }

    fs.writeFileSync(filePath, content, 'utf8');
}

if (instarray[0] === 'rewrite') {
    const text = fs.readFileSync('transformed.out', 'utf8');
    writeFilesFromStr(text);
} else {
    generateJsonData().then(writeFilesFromStr);
}
