# Platform team positions

Admins manage reusable positions in Control Center > Members and security > Platform team. Built-in positions remain fixed. Admins can create a custom position, choose its module-permission template, rename it, revise its template, and archive or reactivate it. Each change requires an audit reason.

Custom position names are unique without regard to capitalization. The application stores a stable opaque key separately from the display name, so renaming a position does not break existing assignments. Archived positions are omitted from new assignments. An assigned position cannot be archived; reassign those collaborators first.

Position templates are defaults, not live policy inheritance. When an admin changes a template, existing collaborators retain their saved permissions until the admin explicitly edits those collaborators. API authorization checks the collaborator's saved module grants, email-verification state, and enabled account status. A position named Administrator does not create a `Role.ADMIN` account and cannot manage collaborators or positions.

Migration `20261030160000_platform_custom_team_positions` adds the position table with a unique normalized-name constraint and an audit-actor foreign key. Existing built-in collaborator assignments remain unchanged.
