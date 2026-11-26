# CARMEN SKILL.md Schema Reference

- Folder name: kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), panjang 2-64 karakter, sama dengan frontmatter `name`.
- Required frontmatter keys: `name`, `description` (<= 1024 karakter), `category`, `version`, `tools`, `permissions`, `triggers`, `execution_mode`.
- Allowed categories: `development`, `debugging`, `security`, `testing`, `database`, `devops`, `architecture`, `agents`.
- Allowed permissions: `READ`, `WRITE`, `EXECUTE`, `NETWORK`, `DATABASE`, `DEPLOY` (`ADMIN` ditolak).
- Required Markdown sections: `## Purpose`, `## When to use`, `## Required context`, `## Workflow`, `## Tool mapping`, `## Verification`, `## Failure handling`, `## Safety constraints`, `## Examples`.
