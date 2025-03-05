const axios = require('axios');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const csv = require('csv-parser');
const { parse } = require('json2csv');
const _ = require('lodash');

const argv = yargs(hideBin(process.argv))
  .option('apiKey', {
    alias: 'k',
    type: 'string',
    description: 'API Key',
    demandOption: true
  })
  .option('projectId', {
    alias: 'p',
    type: 'string',
    description: 'Project ID',
    demandOption: true
  })
  .option('directoryPath', {
    alias: 'd',
    type: 'string',
    description: 'Directory Path',
    demandOption: true
  })
  .option('exportedStories', {
    alias: 's',
    type: 'string',
    description: 'File name for exported stories',
    demandOption: true
  })
  .option('exportedHistory', {
    alias: 'h',
    type: 'string',
    description: 'File name for exported history',
    demandOption: false
  })
  .argv;

const apiKey = argv.apiKey;
const projectId = argv.projectId;
const directoryPath = argv.directoryPath;
const exportedStoriesPath = argv.exportedStories;
const exportedHistoryPath = argv.exportedHistory;

if (!apiKey || !projectId || !directoryPath) {
    console.error('Usage: node export_enhancer.js <API_KEY> <PROJECT_ID> <DIRECTORY_PATH>');
    process.exit(1);
}

const apiUrl = `https://www.pivotaltracker.com/services/v5/projects/${projectId}/stories`;

async function fetchComments(url) {
    try {
        const response = await axios.get(url, {
            headers: { 
                'X-TrackerToken': apiKey,
                "Content-Type": "application/json"
            },
            params: {
                fields: 'comments(id,text,attachments(id,filename))'
            }
        });
        const comments = _.keyBy(response.data, 'id');
        return comments;
    } catch (error) {
        console.error('Error fetching stories:', error);
        return [];
    }
}

async function addAttachmentNames(comments, exportedStories) {
    const storiesFilePath = path.join(directoryPath, exportedStories);
    const transformedRows = [];
    let headers = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(storiesFilePath)
            .pipe(csv())
            .on('headers', (headerList) => {
                headers = headerList;
                headers.push('attachments'); // Add the new column for attachments
            })
            .on('data', (row) => {
                const storyId = row['Id'];

                const storyComments = comments[`${storyId}`];
                if (storyComments) {
                    row.attachments = storyComments.comments.filter(comment => !_.isEmpty(comment.attachments)).map(comment => comment.attachments.map(att => `* ${att.filename}`).join('\n')).join('\n');
                } else {
                    row.attachments = '';
                }
                transformedRows.push(row);
            })
            .on('end', () => {
                const csvData = parse(transformedRows, { fields: headers });
                const transformedFilePath = path.join(directoryPath, path.basename(exportedStories));
                fs.promises.writeFile(transformedFilePath, csvData)
                    .then(() => {
                        console.log(`Transformed CSV saved to ${transformedFilePath}`);
                        resolve();
                    })
                    .catch(error => {
                        console.error(`Error saving transformed CSV:`, error);
                        reject(error);
                    });
            })
            .on('error', (error) => {
                console.error('Error reading CSV:', error);
                reject(error);
            });
    });
}


async function saveToFile(fileName, data) {
    const filePath = path.join(directoryPath, fileName);
    try {
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
        console.log(`Data saved to ${filePath}`);
    } catch (error) {
        console.error(`Error saving data to ${filePath}:`, error);
    }
}

async function main() {
    const comments = await fetchComments(apiUrl);
    await addAttachmentNames(comments, exportedStoriesPath);
    await saveToFile('stories_with_comments.json', comments);
}

main();