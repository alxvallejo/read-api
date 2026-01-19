---
allowed-tools: Bash(git status:*), Bash(git checkout:*), Bash(git pull:*), Bash(git merge:*), Bash(git push:*), Bash(git log:*), Bash(git branch:*)
description: Merge feature branch to main and push to deploy
model: haiku
---

## Context

- Current branch: !`git branch --show-current`
- Git status: !`git status --short`
- Recent commits on current branch: !`git log --oneline -5`

## Your Task

Merge the current feature branch to main and push to deploy.

**Process:**

1. **Verify** current branch is not main (abort if on main)
2. **Verify** working tree is clean (abort if uncommitted changes)
3. **Store** the feature branch name
4. **Checkout main** and pull latest: `git checkout main && git pull`
5. **Merge** the feature branch: `git merge <branch> --no-edit`
6. **Push** to remote: `git push`
7. **Report** the merge commit hash and confirm deployment triggered

**On error:** Stop and report the issue. Never force push.
