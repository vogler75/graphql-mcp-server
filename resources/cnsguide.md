# CNS Tree Creation Guidelines

  1. **Always verify parent paths exist** before calling cnsAddTree or cnsAddNode
     - Use `cnsGetViews(systemName)` to list existing views
     - Use `cnsGetTrees(view)` to list existing trees
     - Reuse existing views when appropriate

  2. **View naming convention**: View paths must end with a colon (`:`)
     - Valid: `"System1.MonsterMQ:"`, `"System1.USA:"`
     - Invalid: `"Govee"` (missing colon)

  3. **Parent path context matters**:
     - `cnsAddTree()` requires: view, existing tree, or existing node
     - `cnsAddNode()` requires: existing node path only (not a view)

  4. **Datapoint linkage**: Include trailing dot (`.`) for datapoints without elements
     - Format: `"System1:DataPointName."`

  This way, I'll remember to validate the structure before attempting operations!

