/**
 * GitHub Learning Engine Sync
 * Saves/loads learning data to/from GitHub
 */

const https = require('https');
const fs = require('fs');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = 'YOUR_USERNAME_HERE';
const GITHUB_REPO = 'pipsight-worker';
const GITHUB_FILE_PATH = 'data/learning-engine-state.json';

function makeGitHubRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'PipSight-Learner',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`GitHub API ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function fetchLearningState() {
  try {
    console.log('Fetching learning state from GitHub...');
    const response = await makeGitHubRequest('GET', GITHUB_FILE_PATH);
    const content = Buffer.from(response.content, 'base64').toString('utf8');
    return JSON.parse(content);
  } catch (error) {
    console.log('Could not fetch:', error.message);
    return null;
  }
}

async function saveLearningState(learningData) {
  try {
    console.log('Saving learning state to GitHub...');
    
    let sha = null;
    try {
      const currentFile = await makeGitHubRequest('GET', GITHUB_FILE_PATH);
      sha = currentFile.sha;
    } catch (e) {
      // File doesn't exist yet
    }

    const content = Buffer.from(JSON.stringify(learningData, null, 2)).toString('base64');
    
    const commitData = {
      message: `[Bot] Update learning engine - ${new Date().toISOString()}`,
      content: content,
      branch: 'main'
    };

    if (sha) commitData.sha = sha;

    await makeGitHubRequest('PUT', GITHUB_FILE_PATH, commitData);
    console.log('Learning state saved!');
    return true;
  } catch (error) {
    console.error('Save failed:', error.message);
    return false;
  }
}

module.exports = {
  fetchLearningState,
  saveLearningState
};
