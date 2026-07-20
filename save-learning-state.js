/**
 * Save Learning Engine State to GitHub
 * Runs via GitHub Actions
 * Fetches current learning data and commits to GitHub
 */

const https = require('https');
const fs = require('fs');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = '7tpzbnydgg-commits';
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

async function getGitHubFile() {
  try {
    return await makeGitHubRequest('GET', GITHUB_FILE_PATH);
  } catch (e) {
    console.log('File not found, will create new');
    return null;
  }
}

async function saveLearningStateToGitHub(learningData) {
  try {
    console.log('Fetching current GitHub file...');
    
    let sha = null;
    const currentFile = await getGitHubFile();
    if (currentFile) {
      sha = currentFile.sha;
    }

    const content = Buffer.from(JSON.stringify(learningData, null, 2)).toString('base64');
    
    const commitData = {
      message: `[Auto] Update learning engine state - ${new Date().toISOString()}`,
      content: content,
      branch: 'main'
    };

    if (sha) commitData.sha = sha;

    await makeGitHubRequest('PUT', GITHUB_FILE_PATH, commitData);
    console.log('✅ Learning state saved to GitHub successfully!');
    return true;
  } catch (error) {
    console.error('❌ Failed to save learning state:', error.message);
    return false;
  }
}

// Main execution
async function main() {
  try {
    // Read learning data from file (created by browser export)
    const dataPath = 'learning-export.json';
    
    if (!fs.existsSync(dataPath)) {
      console.log('No learning export file found. Browser needs to trigger export first.');
      return;
    }

    const localData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    console.log(`Read ${localData.learning.signals.length} signals from local export`);

    await saveLearningStateToGitHub(localData);
    
  } catch (error) {
    console.error('Error in main:', error.message);
  }
}

main();
