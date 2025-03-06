const axios = require('axios');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { parse } = require('json2csv');
const fastcsv = require('fast-csv');
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
    description: 'Path to directory where the resulting transformed CSV will be saved',
    demandOption: true
  })
  .option('exportedStories', {
    alias: 's',
    type: 'string',
    description: 'File name for exported stories',
    demandOption: true
  })
  .option('exportedHistory', {
    alias: 'x',
    type: 'string',
    description: 'File name for exported history',
    demandOption: true
  })
  .help('h')
  .alias('h', 'help')
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

async function parseExportedHistory(filePath) {
    const historyDict = {};

    return new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(fastcsv.parse({ headers: true }))
            .on('data', (row) => {
                // console.log(JSON.stringify(row));
                const id = row['ID'];
                const message = row['Message'];
                const occurredAt = row['Occurred At'];
                const concatenatedValue = `${message} [${occurredAt}]`;
                
                if (!historyDict[id]) {
                    historyDict[id] = [];
                }
                historyDict[id].push(concatenatedValue);
            })
            .on('end', () => {
                resolve(historyDict);
            })
            .on('error', (error) => {
                console.error('Error reading CSV:', error);
                reject(error);
            });
    });
}

async function fetchStoriesByStoryID(url, limit = 100, offset = 0, allStoriesByStoryID = {}) {
    try {
        const response = await axios.get(url, {
            headers: { 
                'X-TrackerToken': apiKey,
                "Content-Type": "application/json"
            },
            params: {
                fields: 'pull_requests(id,host_url,owner,repo,number,original_url),branches(id,host_url,owner,repo,name,original_url),name,comments(id,text,attachments(id,filename))',
                limit: limit,
                offset: offset
            }
        });

        const storiesByStoryID = _.keyBy(response.data, 'id');
        Object.assign(allStoriesByStoryID, storiesByStoryID);

        const paginationOffset = parseInt(response.headers['x-tracker-pagination-offset'], 10);
        const paginationLimit = parseInt(response.headers['x-tracker-pagination-limit'], 10);
        const paginationReturned = parseInt(response.headers['x-tracker-pagination-returned'], 10);
        const paginationTotal = parseInt(response.headers['x-tracker-pagination-total'], 10);
        console.log(`Fetched ${paginationReturned} stories of a Total ${paginationTotal}`);
        if ((paginationOffset + paginationLimit) < paginationTotal) {
            return await fetchStoriesByStoryID(url, paginationLimit, paginationOffset + paginationLimit, allStoriesByStoryID);
        } else {
            return allStoriesByStoryID;
        }
    } catch (error) {
        console.error('Error fetching stories:', error);
        return allStoriesByStoryID;
    }
}



async function addAdditionalInformation(storiesByStoryID, exportedStories, historyByStoryID) {
    const storiesFilePath = exportedStories;
    const transformedRows = [];
    let headers = [];
    let originalHeaders = [];
    const headerCount = {};

    return new Promise((resolve, reject) => {
        fs.createReadStream(storiesFilePath)
            .pipe(fastcsv.parse({ headers: (headerList) => {
                originalHeaders = headerList;
                const headers = headerList.map(header => {
                    if (headerCount[header] >= 1) {
                        headerCount[header]++;
                        return `${header}_${headerCount[header]}`;
                    } else {
                        const suffix = headerList.filter(h => h === header).length > 1 ? "_1" : "";
                        headerCount[header] = 1;
                        return `${header}${suffix}`;
                    }
                });
                const lastCommentNumber = headerCount["Comment"]
                const lastCommentHeader = `Comment_${lastCommentNumber}`;
                const newCommentHeader = `Comment_${lastCommentNumber + 1}`;
                const lastCommentHeaderIndex = headers.indexOf(lastCommentHeader);
                const newHeaders = [...headers];
                newHeaders.splice(lastCommentHeaderIndex + 1, 0, newCommentHeader);
                originalHeaders.splice(lastCommentHeaderIndex + 1, 0, "Comment");

                return headers;
            }}))
            .on('headers', (headerList) => {
                headers = headerList;
            })
            .on('data', (row) => {
                const storyId = row[Object.keys(row)[0]];
                const storyComments = storiesByStoryID[`${storyId}`];
                if (storyComments) {
                    let commentIndex = 1;
                    let commentField = `Comment_${commentIndex}`;
                    while (row.hasOwnProperty(commentField)) {
                        const comment = storyComments.comments[commentIndex - 1];
                        
                        if (comment && comment.attachments.length > 0) {
                            const attachmentsText = `\n---\nAttachments:\n${comment.attachments.map(att => `* ${att.filename}`).join('\n')}\n---\n`;
                            const regex = /\s*\([^)]*\)\s*$/; // Matches text inside parentheses at the end of the comment
                            if (regex.test(row[commentField])) {
                                row[commentField] = row[commentField].replace(regex, attachmentsText + ' $&');
                            } else {
                                console.log("No match");
                            }
                        }
                        commentIndex++;
                        commentField = `Comment_${commentIndex}`;

                    }                    


                }

                const newCommentNumber = (storyComments?.comments ?? []).length + 1;
                const projectInfoCommentFieldName = `Comment_${newCommentNumber}`;
                const historyMessages = _.isEmpty(historyByStoryID[`${storyId}`]) ? [] : historyByStoryID[`${storyId}`]?.map(historyEntry => `* ${historyEntry}`);

                const pullRequests = storyComments?.pull_requests ?? [];
                const pullRequestLinks = pullRequests.map(pullRequest => `* ${pullRequest.host_url}${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}`);
                const branches = storyComments?.branches ?? [];
                const branchLinks = branches.map(branch => `* ${branch.host_url}${branch.owner}/${branch.repo}/tree/${branch.name}`);
                

                row[projectInfoCommentFieldName] = ["PivotalTracker Project Information", "---", "Branches:", ...branchLinks, "\nPull Requests:", ...pullRequestLinks, "\nAvailable History:", ...historyMessages].filter(Boolean)
                    .join('\n');

                transformedRows.push(row);
            })
            .on('end', () => {
                const parsedCSVData = parse(transformedRows, { fields: headers });
                const csvLines = parsedCSVData.split('\n');
                csvLines.shift(); // Remove the first line (headers)
                const newHeaderLine = originalHeaders.map(header => `"${header}"`).join(',');
                const csvData = [newHeaderLine, ...csvLines].join('\n');

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
    const [stories, historyByStoryID] = await Promise.all([fetchStoriesByStoryID(apiUrl), parseExportedHistory(exportedHistoryPath)]);
    await addAdditionalInformation(stories, exportedStoriesPath, historyByStoryID);
}

main();