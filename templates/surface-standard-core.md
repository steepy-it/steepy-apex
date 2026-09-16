# {{name}} — Surface Core

> Owning path: `{{path}}`. Read this before editing `{{path}}`.

## Scope
- Owns: (what this surface is responsible for)
- Does NOT own: (the nearest things that belong to other surfaces)
- Exemplar: `(the canonical file to read first)`

## Conventions
- (Add the non-negotiable conventions for this surface — these apply to all sub-areas. Sub-area-specific rules live in leaf docs.)

## Sub-area routing
Load this core, then every leaf whose row matches the task; zero matches → this core only.

| Sub-area | When to read it (path/topic) | Doc |
| --- | --- | --- |
| (sub-area) | (when/what) | [`{{name}}-(sub-area).md`]({{name}}-(sub-area).md) |

## Testing
Narrowest validation that can falsify a change here:

```sh
{{testCmd}}
```
