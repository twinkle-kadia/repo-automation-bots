/**
 * Copyright 2020 Google LLC. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
SQL Helpers:
*/
CREATE TEMP FUNCTION json2array(json STRING)
RETURNS ARRAY<STRING>
LANGUAGE js AS """
  return JSON.parse(json).map(x => JSON.stringify(x));
""";

/*
Determines monthly releases by looking for "ReleaseEvent"s created by
the yoshi-automation user.

This measures the impact of release-plese and related bots, e.g.,
"failurechecker", "conventional-commit-lint".
*/
SELECT * FROM (SELECT COUNT(id) as actions, month_start, 12.5 as minutes, 'release' as type FROM (
  SELECT DATE_TRUNC(DATE(created_at), MONTH) as month_start, id
  FROM `githubarchive.day.20*`
  WHERE
  _TABLE_SUFFIX BETWEEN '190101' AND '210101' AND
  (
    repo.name LIKE 'googleapis/%' OR
    repo.name LIKE 'GoogleCloudPlatform/%'
  ) AND
  JSON_EXTRACT(payload, '$.action') LIKE '"published"' AND
  actor.login = 'yoshi-automation' AND
  type = 'ReleaseEvent'
)
GROUP BY month_start
ORDER BY month_start ASC)

UNION ALL

/*
Determines how many PRs were created by renovate bot.

This is meant to measure the impact of the trusted-contribution bot; prior
to this bot users needed to kick of CI by hand.
*/
SELECT * FROM (SELECT COUNT(id) as actions, month_start, 0.75 as minutes, 'renovate-run' as type FROM (
  SELECT DATE_TRUNC(DATE(created_at), MONTH) as month_start, id
  FROM `githubarchive.day.20*`
  WHERE
  _TABLE_SUFFIX BETWEEN '190101' AND '210101' AND
  (
    repo.name LIKE 'googleapis/%' OR
    repo.name LIKE 'GoogleCloudPlatform/%'
  ) AND
  actor.login LIKE "renovate-bot" AND
  JSON_EXTRACT(payload, '$.action') LIKE '"opened"' AND
  type = 'PullRequestEvent'
)
GROUP BY month_start
ORDER BY month_start ASC)

UNION ALL

/*
Determines how many issues were opened by build-cop-bot, prior to build-cop
users needed to manually detect failing nightly builds, and open issues
on GitHub.
*/
SELECT * FROM (SELECT COUNT(id) as actions, month_start, 6 as minutes, 'build-cop' as type FROM (
  SELECT DATE_TRUNC(DATE(created_at), MONTH) as month_start, id
  FROM `githubarchive.day.20*`
  WHERE
  _TABLE_SUFFIX BETWEEN '190101' AND '210101' AND
  (
    repo.name LIKE 'googleapis/%' OR
    repo.name LIKE 'GoogleCloudPlatform/%'
  ) AND
  actor.login LIKE "build-cop-bot%" AND
  JSON_EXTRACT(payload, '$.action') LIKE '"opened"' AND
  type = 'IssuesEvent'
)
GROUP BY month_start
ORDER BY month_start ASC)

UNION ALL

/*
Measures PRs that have been assigned to at least one user.

This is meant to measure the impact of blunderbuss, which automatically
assigns reviewers.
*/
SELECT * FROM (SELECT COUNT(id) as actions, month_start, 1.3 as minutes, 'pr-assignment' as type FROM (
  SELECT DATE_TRUNC(DATE(created_at), MONTH) as month_start, id
  FROM `githubarchive.day.20*`
  WHERE
  _TABLE_SUFFIX BETWEEN '190101' AND '210101' AND
  (
    repo.name LIKE 'googleapis/%' OR
    repo.name LIKE 'GoogleCloudPlatform/%'
  ) AND
  JSON_EXTRACT(payload, '$.action') LIKE '"opened"' AND
  ARRAY_LENGTH(json2array(JSON_EXTRACT(payload, '$.pull_request.assignees'))) > 0 AND
  type = 'PullRequestEvent'
)
GROUP BY month_start
ORDER BY month_start ASC)