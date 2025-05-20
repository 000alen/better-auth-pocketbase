import { AdapterSchemaCreation } from "better-auth/types";

// Define a type for the attribute object to resolve linter errors
export type TableFieldAttribute = {
  type: string;
  references?: {
    model: string;
    onDelete?: "cascade" | "restrict" | "setNull";
  };
  fieldName?: string;
  required?: boolean;
  unique?: boolean;
  // Extend as necessary
};

/**
 * Performs a topological sort on tables based on their references
 */
function topologicalSort(tables: Record<string, any>) {
  const graph = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const sorted: any[] = [];
  const temporaryMark = new Set<string>();
  const cycles: string[][] = [];
  let currentPath: string[] = [];

  // Build the dependency graph
  for (const [_, table] of Object.entries(tables)) {
    if (table.disableMigrations) continue;

    const tableName = table.modelName;
    if (!graph.has(tableName)) {
      graph.set(tableName, new Set());
    }

    // Add dependencies based on references
    for (const [_, field] of Object.entries(table.fields)) {
      const attr = field as TableFieldAttribute;
      if (attr.references) {
        const refName = attr.references.model;
        graph.get(tableName)!.add(refName);
      }
    }
  }

  // Visit function for depth-first search
  function visit(tableName: string) {
    if (visited.has(tableName)) return true;
    if (temporaryMark.has(tableName)) {
      // Found a cycle - capture it
      const cycleStart = currentPath.indexOf(tableName);
      if (cycleStart !== -1) {
        const cycle = currentPath.slice(cycleStart).concat(tableName);
        cycles.push(cycle);
      }
      return false;
    }

    temporaryMark.add(tableName);
    currentPath.push(tableName);

    const dependencies = graph.get(tableName) || new Set();
    for (const dep of dependencies) {
      visit(dep);
    }

    currentPath.pop();
    temporaryMark.delete(tableName);
    visited.add(tableName);

    // Find the original table object
    const table = Object.values(tables).find(t =>
      (t.modelName) === tableName
    );
    if (table && !table.disableMigrations) {
      sorted.unshift(table);
    }
    return true;
  }

  // Perform topological sort
  for (const tableName of graph.keys()) {
    if (!visited.has(tableName)) {
      visit(tableName);
    }
  }

  // Print cycle alerts if any were found
  if (cycles.length > 0) {
    console.warn("\n⚠️ WARNING: Circular dependencies detected in schema!");
    console.warn("The following cycles were found:");
    cycles.forEach((cycle, i) => {
      console.warn(`  Cycle ${i + 1}: ${cycle.join(" → ")} → ${cycle[0]}`);
    });
    console.warn("\nThis may cause issues with referential integrity and migrations.");
    console.warn("Consider restructuring your schema to remove these circular dependencies.\n");
  }

  return sorted;
}

// Helper function to pluralize words
function pluralise(w: string) {
  return w.endsWith("s") ? w : `${w}s`;
}

/**
 * Generates a PocketBase migration that creates (and on rollback deletes)
 * collections derived from Better‑Auth metadata.
 *
 * **Key differences vs. the previous version**
 *   • Relation fields now include `collectionId` (not just collectionName) –
 *     PocketBase requires the literal UUID of the referenced collection.
 *   • All relation‑specific props (`collectionId`, `cascadeDelete`, `maxSelect`)
 *     are placed at the top level of the field object, matching PB export JSON.
 *   • A two‑pass build assigns a deterministic random `id` to every collection
 *     first, so relation fields can reference that ID even if the target
 *     collection appears later in the source list.
 *   • Collections are sorted topologically to ensure referenced collections
 *     are created before their dependents.
 */
export function generatePocketBaseSchema({
  tables,
  file,
  collectionPrefix,
}: {
  tables: Record<string, any>;
  file?: string;
  collectionPrefix?: string;
}): AdapterSchemaCreation {
  /* ---------- helpers --------------------------------------------------- */
  const randId = (prefix: string) => `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;

  /* ---------- PB field & collection shape ------------------------------- */
  type PbField = {
    id?: string;
    name: string;
    type: string;
    required: boolean;
    unique?: boolean;
    system?: boolean;
    presentable?: boolean;
    hidden?: boolean;
    primaryKey?: boolean;
    autogeneratePattern?: string;
    pattern?: string;
    min?: number;
    max?: number;
    // autodate
    onCreate?: boolean;
    onUpdate?: boolean;
    // relation‑specific
    collectionId?: string;
    cascadeDelete?: boolean;
    maxSelect?: number | null;
    minSelect?: number | null;
  };

  type PbCollection = {
    id: string;
    name: string;
    type: "base";
    system: boolean;
    fields: PbField[];
    listRule: null | string;
    viewRule: null | string;
    createRule: null | string;
    updateRule: null | string;
    deleteRule: null | string;
    indexes: string[];
  };

  /* ---------- 1st pass – assign collection IDs -------------------------- */
  const meta = topologicalSort(tables).reverse();

  const colIdByModel: Record<string, string> = {};
  for (const tbl of meta) {
    const rawName = tbl.modelName;
    const name = collectionPrefix ? `${collectionPrefix}${rawName}` : rawName;
    colIdByModel[name] = randId("pbc_");
  }

  /* ---------- 2nd pass – build full definitions ------------------------- */
  const collections: PbCollection[] = meta.map((tbl) => {
    const rawName = tbl.modelName;
    const name = collectionPrefix ? `${collectionPrefix}${rawName}` : rawName;
    const thisColId = colIdByModel[name];

    const fields: PbField[] = [];

    // ----- system id field
    fields.push({
      id: randId("text"),
      name: "id",
      type: "text",
      required: true,
      primaryKey: true,
      system: true,
      presentable: false,
      autogeneratePattern: "[a-z0-9]{15}",
      pattern: "^[a-z0-9]+$",
      min: 15,
      max: 15,
    });

    // ----- user‑defined schema
    for (const [fname, attrUntyped] of Object.entries(tbl.fields)) {
      const attr = attrUntyped as TableFieldAttribute;
      const fmap: Record<string, string> = {
        string: "text",
        number: "number",
        boolean: "bool",
        date: "date",
        json: "json",
      };
      let type = fmap[attr.type] ?? "json";

      // * NOTE: `emailVerified` is marked as required, but no value is provided by default on sign up
      const field: PbField = {
        id: randId(type),
        name: attr.fieldName ?? fname,
        type,
        // required: attr.required ?? false,
        required: type === "bool"
          ? false
          : attr.required ?? false,
        unique: attr.unique ?? false,
        system: false,
        presentable: true,
        hidden: false,
        primaryKey: false,
      };

      // ---- relation handling
      if (attr.references) {
        field.type = "relation";
        const refRaw = attr.references.model;
        const refName = collectionPrefix ? `${collectionPrefix}${refRaw}` : refRaw;

        field.collectionId = colIdByModel[refName] ?? "_pb_users_auth_"; // fall back to system users
        field.cascadeDelete = (attr.references.onDelete ?? "cascade") === "cascade";
        field.maxSelect = 1;
        field.minSelect = 0;
      }

      fields.push(field);
    }

    // ----- created / updated autodate
    fields.push({
      id: randId("autodate"),
      name: "created",
      type: "autodate",
      onCreate: true,
      onUpdate: false,
      required: false,
      system: false,
      presentable: false,
    });
    fields.push({
      id: randId("autodate"),
      name: "updated",
      type: "autodate",
      onCreate: true,
      onUpdate: true,
      required: false,
      system: false,
      presentable: false,
    });

    return {
      id: thisColId,
      name,
      type: "base",
      system: false,
      fields,
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      indexes: [],
    } as PbCollection;
  });

  /* ---------- migration template --------------------------------------- */
  // const migrationTimestamp = Math.floor(Date.now() / 1000);
  // const defaultFileName = `${migrationTimestamp}_created_better_auth_collections.js`;
  const defaultFileName = `created_better_auth_collections.js`;

  const code = `/// <reference path="../pb_data/types.d.ts" />

/**
 * Auto-generated PocketBase migration – do NOT edit by hand.
 */

migrate((app) => {
  const collections = ${JSON.stringify(collections, null, 2)};
  let newlyCreatedCollections = [];
  let addedFieldsToExistingCollections = [];

  // Helper function to generate random ID for fields, if not already present in definition
  // This is defined within the migration script's scope
  const randId = (prefix = 'fld_') => \`\${prefix}\${Math.random().toString(36).substring(2, 10)}\`;

  for (const def of collections) {
    let existingCollection;
    try {
      existingCollection = app.findCollectionByNameOrId(def.name);
    } catch {
      // Collection does not exist
    }

    if (existingCollection) {
      console.info(\`[PB] Collection ${'${'}def.name${'}'} exists. Checking fields...\`);
      const existingFieldNames = existingCollection.schema.fields.map(f => f.name);

      for (const fieldDef of def.fields) {
        if (fieldDef.system || ['id', 'created', 'updated'].includes(fieldDef.name)) {
          continue;
        }

        if (!existingFieldNames.includes(fieldDef.name)) {
          try {
            // Ensure new field has a unique ID, using the one from PbField if available
            const fieldId = fieldDef.id || randId(fieldDef.type.substring(0, 3) + '_');
            const fieldSchemaData = { ...fieldDef, id: fieldId };

            // Remove properties not part of SchemaField constructor if they exist
            delete fieldSchemaData.system;
            delete fieldSchemaData.primaryKey;
            delete fieldSchemaData.presentable; // Not a direct SchemaField property
            delete fieldSchemaData.hidden; // Not a direct SchemaField property
            delete fieldSchemaData.autogeneratePattern; // Not a direct SchemaField property
            delete fieldSchemaData.onCreate; // Not a direct SchemaField property
            delete fieldSchemaData.onUpdate; // Not a direct SchemaField property


            const newSchemaField = new SchemaField(fieldSchemaData);
            existingCollection.schema.addField(newSchemaField);
            app.saveCollection(existingCollection);

            addedFieldsToExistingCollections.push({ collectionName: def.name, fieldName: fieldDef.name });
            console.info(\`[PB] Added field ${'${'}fieldDef.name${'}'} to collection ${'${'}def.name${'}'}.\`);
          } catch (e) {
            console.error(\`[PB] Error adding field ${'${'}fieldDef.name${'}'} to ${'${'}def.name${'}'}: \`, e.message, e.stack);
          }
        } else {
          console.info(\`[PB] Field ${'${'}fieldDef.name${'}'} already exists in ${'${'}def.name${'}'} – skipping.\`);
        }
      }
    } else {
      try {
        // Ensure all fields have IDs for new collection
        const collectionDefWithFieldIds = {
          ...def,
          fields: def.fields.map(f => ({ ...f, id: f.id || randId(f.type.substring(0,3) + '_') }))
        };
        app.save(new Collection(collectionDefWithFieldIds));
        newlyCreatedCollections.push(def.name);
        console.info(\`[PB] Created collection ${'${'}def.name${'}'}.\`);
      } catch (e) {
        console.error(\`[PB] Error creating collection ${'${'}def.name${'}'}: \`, e.message, e.stack);
      }
    }
  }
}, (app) => {
  // Rollback added fields from existing collections
  console.info("[PB] Rolling back added fields...");
  for (const entry of addedFieldsToExistingCollections.reverse()) {
    try {
      const col = app.findCollectionByNameOrId(entry.collectionName);
      if (col) {
        const fieldInstance = col.schema.getFieldByName(entry.fieldName);
        if (fieldInstance) {
          col.schema.removeField(fieldInstance.id);
          app.saveCollection(col);
          console.info(\`[PB] Rolled back: removed field '\${entry.fieldName}' from \${entry.collectionName}.\`);
        } else {
          console.warn(\`[PB] Field '\${entry.fieldName}' not found in collection '\${entry.collectionName}' during field rollback.\`);
        }
      } else {
        console.warn(\`[PB] Collection '\${entry.collectionName}' not found during field rollback.\`);
      }
    } catch (e) {
      console.error(\`[PB] Error rolling back field '\${entry.fieldName}' from \${entry.collectionName}: \`, e.message, e.stack);
    }
  }

  // Rollback newly created collections
  console.info("[PB] Rolling back newly created collections...");
  for (const collectionName of newlyCreatedCollections.reverse()) {
    try {
      const col = app.findCollectionByNameOrId(collectionName);
      if (col) {
        app.deleteCollection(col);
        console.info(\`[PB] Rolled back: deleted collection '\${collectionName}'.\`);
      } else {
        console.warn(\`[PB] Collection '\${collectionName}' not found during collection rollback.\`);
      }
    } catch (e) {
      console.error(\`[PB] Error rolling back collection '\${collectionName}': \`, e.message, e.stack);
    }
  }
});`;

  return {
    code,
    path: file ?? defaultFileName,
    overwrite: true,
  };
}
