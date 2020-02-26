// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Application } from 'probot';
import { request } from 'gaxios';
import { GitHubAPI } from 'probot/lib/github';
import { createHash } from 'crypto';
import { Storage } from '@google-cloud/storage';
const storage = new Storage();

interface Labels {
  labels: [
    {
      name: string;
      description: string;
      color: string;
    }
  ];
}

interface Repos {
  repos: [
    {
      language: string;
      repo: string;
    }
  ];
}

interface GetApiLabelsResponse {
  apis: Array<{
    display_name: string; // Access Approval
    github_label: string; // api: accessapproval
    api_shortname: string; // accessapproval
  }>;
}

interface PublicReposResponse {
  repos: Array<{
    repo: string;
    github_label: string;
  }>;
}

// Labels are fetched by reaching out to GitHub *instead* of grabbing the file
// from the local copy.  We are using the `PushEvent` to detect the change,
// meaning the file running in cloud will be older than the one on master.
let labelsCache: Labels;
async function getLabels(github: GitHubAPI, repoPath: string): Promise<Labels> {
  if (!labelsCache) {
    await refreshLabels(github);
  }
  const labels = {
    labels: labelsCache.labels.slice(0),
  } as Labels;
  const apiLabelsRes = await getApiLabels(repoPath);
  apiLabelsRes.apis.forEach(api => {
    labels.labels.push({
      name: api.github_label,
      description: `Issues related to the ${api.display_name} API.`,
      color: createHash('md5')
        .update(api.api_shortname)
        .digest('hex')
        .slice(0, 6),
    });
  });
  return labels;
}

/**
 * Reach out to github, and snag `labels.json` from HEAD of this repository.
 * @param github Reference to OctoKit GitHub API
 */
async function refreshLabels(github: GitHubAPI): Promise<void> {
  const data = (
    await github.repos.getContents({
      owner: 'googleapis',
      repo: 'repo-automation-bots',
      path: 'packages/label-sync/src/labels.json',
    })
  ).data as { content?: string };
  labelsCache = JSON.parse(
    Buffer.from(data.content as string, 'base64').toString('utf8')
  );
}

function handler(app: Application) {
  const events = [
    'repository.created',
    'repository.transferred',
    'label.edited',
    'label.deleted',
  ];

  app.on(events, async c => {
    const { owner, repo } = c.repo();
    await reconcileLabels(c.github, owner, repo);
  });

  app.on('push', async context => {
    const { owner, repo } = context.repo();
    // TODO: Limit this to pushes that edit `labels.json`
    if (
      owner === 'googleapis' &&
      repo === 'repo-automation-bots' &&
      context.payload.ref === 'refs/heads/master'
    ) {
      await refreshLabels(context.github);
      const url =
        'https://raw.githubusercontent.com/googleapis/sloth/master/repos.json';
      const res = await request<Repos>({ url });
      const { repos } = res.data;
      for (const r of repos) {
        const [owner, repo] = r.repo.split('/');
        await reconcileLabels(context.github, owner, repo);
      }
    }
  });
}

/**
 * Reach out to GCS and find a list of products populated by DRIFT.
 * For each product in that list, we want to create an `api: <product>` label.
 * @param repoPath GitHub repo path, in <owner>/<name> format
 */
async function getApiLabels(repoPath: string): Promise<GetApiLabelsResponse> {

  // Get a list of repositories trcked from DRIFT. Each repository may have
  // associated `github_label`.
  const publicRepos = await storage
    .bucket('devrel-prod-settings')
    .file('public_repos.json')
    .download();
  const repo = (JSON.parse(
    publicRepos[0].toString()
  ) as PublicReposResponse).repos.find(repo => {
    return repo.repo === repoPath && repo.github_label !== '';
  });

  // If DRIFT knows about an associate between the repository and a particular
  // github_label, only populate that label
  if (repo) {
    // for split-repos we populate only the label associated with the
    // product the repo is associated with:
    console.log(`populating ${repo.github_label} label for ${repoPath}`);
    return {
      apis: [
        {
          github_label: repo.github_label,
          api_shortname: repoPath.split('/')[1],
          display_name: repoPath,
        },
      ],
    };
  }

  // for mono-repos we populate a list of all apis and products,
  // since each repo might include multiple products:
  console.log(`populating all api labels for ${repoPath}`);
  const apis = await storage
    .bucket('devrel-prod-settings')
    .file('apis.json')
    .download();
  return JSON.parse(apis[0].toString()) as GetApiLabelsResponse;
};

/**
 * Build the list of all labels that should be on the repo, get the list of
 * labels on the repo in real life, then synchronize it.
 */
async function reconcileLabels(github: GitHubAPI, owner: string, repo: string) {
  const newLabels = await getLabels(github, `${owner}/${repo}`);
  const res = await github.issues.listLabelsForRepo({
    owner,
    repo,
    per_page: 100,
  });
  const oldLabels = res.data;
  for (const l of newLabels.labels) {
    // try to find a label with the same name
    const match = oldLabels.find(
      x => x.name.toLowerCase() === l.name.toLowerCase()
    );
    if (match) {
      // check to see if the color matches
      if (match.color !== l.color || match.description !== l.description) {
        console.log(
          `Updating ${match.name} from ${match.color} to ${l.color} and ${match.description} to ${l.description}.`
        );
        await github.issues
          .updateLabel({
            repo,
            owner,
            name: l.name,
            current_name: l.name,
            description: l.description,
            color: l.color,
          })
          .catch(e => {
            console.error(`Error updating label ${l.name} in ${owner}/${repo}`);
            console.error(e.stack);
          });
      }
    } else {
      // there was no match, go ahead and add it
      console.log(`Creating label for ${l.name}.`);
      await github.issues
        .createLabel({
          repo,
          owner,
          color: l.color,
          description: l.description,
          name: l.name,
        })
        .catch(e => {
          //ignores errors that are caused by two requests kicking off at the same time
          if (
            !Array.isArray(e.errors) ||
            e.errors[0].code !== 'already_exists'
          ) {
            console.error(`Error creating label ${l.name} in ${owner}/${repo}`);
            console.error(e.stack);
          }
        });
    }
  }

  // now clean up common labels we don't want
  const labelsToDelete = [
    'bug',
    'enhancement',
    'kokoro:force-ci',
    'kokoro: force-run',
    'kokoro: run',
    'question',
  ];
  for (const l of oldLabels) {
    if (labelsToDelete.includes(l.name)) {
      await github.issues
        .deleteLabel({
          name: l.name,
          owner,
          repo,
        })
        .then(() => {
          console.log(`Deleted '${l.name}' from ${owner}/${repo}`);
        })
        .catch(e => {
          console.error(`Error deleting label ${l.name} in ${owner}/${repo}`);
          console.error(e.stack);
        });
    }
  }
}

export = handler;