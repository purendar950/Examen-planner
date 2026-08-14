# GitHub connection and AI pull requests

StudyPlanner AI Chat now supports a user-authorized GitHub workflow. A user can connect GitHub, load a repository and branch, select code files, ask the AI to prepare a change, review the proposed full-file contents, and explicitly create a branch, commit, and pull request. The browser never receives or stores the GitHub access token.

## Configure the GitHub OAuth App

Create a GitHub OAuth App under **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**. Use the deployed Render callback URL as the authorization callback URL:

```text
https://YOUR-RENDER-SERVICE.onrender.com/api/ai-chat/github/oauth/callback
```

The app needs the classic `repo` scope because the workflow can write selected files and open pull requests in repositories authorized by the user. The user still reviews the proposed files and must press **Create pull request** before any branch or commit is created.

## Configure Render

Set these environment variables on the backend Render service:

| Variable | Value |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | OAuth App client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | OAuth App client secret; keep it only in Render secrets |
| `GITHUB_OAUTH_REDIRECT_URI` | The exact callback URL registered in GitHub |
| `GITHUB_OAUTH_FRONTEND_ORIGIN` | `https://examzen.in` or the exact deployed frontend origin |
| `GITHUB_TOKEN` | Optional server token for higher public GitHub API rate limits; it is not sent to the browser |

The OAuth state, verifier, and connected user token are stored server-side per Firebase user. The state expires after ten minutes, and review drafts expire after thirty minutes. A draft can edit only the files selected in the current chat, rejects path traversal, rejects binary or oversized files, checks the base-file SHA immediately before writing, and refuses to reuse the base branch as the new branch.

## User flow

Open **AI Chat → GitHub**, choose **Connect GitHub**, and authorize the requested repository access. Load the repository and branch, select the files to edit, and ask the AI for the desired code change. Press **Prepare PR from latest request** to generate a reviewable proposal. Inspect every proposed file, provide a new branch name, and press **Create pull request** only when the diff is correct. The backend then creates the branch, commits the selected files, and opens the pull request through the connected GitHub account.

Disconnecting GitHub removes the server-side connection record for the Firebase user. Existing pull requests and repository history are not deleted.

## Important deployment note

GitHub OAuth configuration is intentionally not committed with credentials. After merging the code changes, set the Render variables above and redeploy the backend. Until those variables are present, the AI Chat panel will remain read-only and will display that GitHub OAuth is not configured.

## References

1. [GitHub: Authorizing OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
2. [GitHub REST API: Repository contents](https://docs.github.com/en/rest/repos/contents)
3. [GitHub REST API: Pull requests](https://docs.github.com/en/rest/pulls/pulls)
4. [GitHub REST API: Git references](https://docs.github.com/en/rest/git/refs)

