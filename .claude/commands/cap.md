---
allowed-tools: Bash(git add:*), Bash(git commit:*), Bash(git push:*), Bash(git diff:*), Bash(git status:*), Bash(git log:*)
description: Auto-commit and push changes with AI-generated summary
model: haiku
---

## Context

- Current git status: !`git status`
- Current git diff: !`git diff HEAD`
- Recent commits: !`git log --oneline -5`

## Your Task

Analyze the changes above and create a concise one-line commit message (under 72 characters, imperative mood).

Then:
1. Stage all changes: `git add .`
2. Create the commit with your generated message
3. Push to the remote branch
