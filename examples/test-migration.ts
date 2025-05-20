import { pocketbaseAdapter } from "../src/index"; // Adjust path as necessary
import { AdapterSchemaCreation } from "better-auth/types";

// Define a type for the table schema, similar to how betterAuth might structure it.
// Based on the example in the task description and knowledge of src/codegen.ts
type FieldDefinition = {
  type: string;
  fieldName?: string;
  required?: boolean;
  unique?: boolean;
  references?: {
    model: string;
    onDelete?: "cascade" | "restrict" | "setNull";
  };
};

type TableDefinition = {
  modelName: string;
  fields: Record<string, FieldDefinition>;
  disableMigrations?: boolean;
};

type SchemaDefinition = Record<string, TableDefinition>;

async function generateMigrationTest() {
  console.log("Starting migration generation test...");
  const collectionPrefix = "test_"; // Consistent prefix

  // --- Stage 1: Initial Schema Definition ---
  const initialSchema: SchemaDefinition = {
    test_users: {
      modelName: "test_users",
      fields: {
        name: { type: "string", fieldName: "name", required: true },
        email: { type: "string", fieldName: "email", unique: true, required: true },
      },
    },
  };

  const adapterStage1 = pocketbaseAdapter({
    url: "http://127.0.0.1:8090", 
    collectionPrefix,
  });

  console.log("Generating migration1.js...");
  try {
    const migration1Result: AdapterSchemaCreation = await adapterStage1.createSchema({
      tables: initialSchema,
      file: "./migration1.js", 
    });
    console.log(`migration1.js generated successfully at ${migration1Result.path}`);
  } catch (error) {
    console.error("Error generating migration1.js:", error);
  }

  // --- Stage 2: Modified Schema Definition (Adding a Field) ---
  const modifiedSchema: SchemaDefinition = {
    test_users: {
      modelName: "test_users", 
      fields: {
        name: { type: "string", fieldName: "name", required: true },
        email: { type: "string", fieldName: "email", unique: true, required: true },
        age: { type: "number", fieldName: "age", required: false }, // New field
      },
    },
  };

  const adapterStage2 = pocketbaseAdapter({
    url: "http://127.0.0.1:8090", 
    collectionPrefix, 
  });

  console.log("\nGenerating migration2.js...");
  try {
    const migration2Result: AdapterSchemaCreation = await adapterStage2.createSchema({
      tables: modifiedSchema,
      file: "./migration2.js", 
    });
    console.log(`migration2.js generated successfully at ${migration2Result.path}`);
  } catch (error) {
    console.error("Error generating migration2.js:", error);
  }

  // --- Stage 3: New Collection Definition ---
  const schemaStage3: SchemaDefinition = {
    test_posts: {
      modelName: "test_posts",
      fields: {
        title: { type: "string", fieldName: "title", required: true },
        content: { type: "string", fieldName: "content", required: false },
      },
    },
  };

  const adapterStage3 = pocketbaseAdapter({
    url: "http://127.0.0.1:8090",
    collectionPrefix,
  });

  console.log("\nGenerating migration3.js...");
  try {
    const migration3Result: AdapterSchemaCreation = await adapterStage3.createSchema({
      tables: schemaStage3,
      file: "./migration3.js",
    });
    console.log(`migration3.js generated successfully at ${migration3Result.path}`);
  } catch (error) {
    console.error("Error generating migration3.js:", error);
  }


  console.log("\nMigration generation test finished.");
  console.log("Please verify the contents of migration1.js, migration2.js, and migration3.js based on the expectations below.");

  // --- Expectations ---

  console.log("\nExpected content for migration1.js (key parts of 'down' function):");
  console.log(`
// ...
// migrate((app) => { /* up logic */ }, (app) => {
//   // Rollback newly created collections
//   console.info("[PB] Rolling back newly created collections...");
//   // newlyCreatedCollections would be ['test_test_users']
//   for (const collectionName of newlyCreatedCollections.reverse()) {
//     try {
//       const col = app.findCollectionByNameOrId(collectionName);
//       if (col) {
//         app.deleteCollection(col);
//         console.info(\`[PB] Rolled back: deleted collection '\${collectionName}'.\`);
//       } // ...
//     } // ...
//   }
// });
  `);

  console.log("\nExpected content for migration2.js (key parts of 'down' function):");
  console.log(`
// ...
// migrate((app) => { /* up logic where 'age' field is added to 'test_test_users' */ }, (app) => {
//   // newlyCreatedCollections = []; (assuming test_test_users already existed)
//   // addedFieldsToExistingCollections = [{ collectionName: 'test_test_users', fieldName: 'age' }];
//
//   // Rollback added fields from existing collections
//   console.info("[PB] Rolling back added fields...");
//   for (const entry of addedFieldsToExistingCollections.reverse()) { // Will iterate for 'age' field
//     try {
//       const col = app.findCollectionByNameOrId(entry.collectionName); // Should be 'test_test_users'
//       if (col) {
//         const fieldInstance = col.schema.getFieldByName(entry.fieldName); // Should be 'age'
//         if (fieldInstance) {
//           col.schema.removeField(fieldInstance.id); // Removes 'age' field
//           app.saveCollection(col);
//           console.info(\`[PB] Rolled back: removed field '\${entry.fieldName}' from \${entry.collectionName}.\`);
//         } // ...
//       } // ...
//     } // ...
//   }
//
//   // Rollback newly created collections
//   console.info("[PB] Rolling back newly created collections...");
//   // newlyCreatedCollections loop will run but the array should be empty for this migration's context,
//   // so test_test_users collection itself is NOT deleted here.
//   for (const collectionName of newlyCreatedCollections.reverse()) {
//     // ... this loop does nothing if newlyCreatedCollections is empty ...
//   }
// });
  `);

  console.log("\nExpected content for migration3.js (key parts of 'up' and 'down' functions):");
  console.log(`
// ...
// migrate((app) => { 
//   // collections = [{ name: "test_test_posts", fields: [..., {name: "title"}, {name: "content"} ...] }]
//   // newlyCreatedCollections = [];
//   // addedFieldsToExistingCollections = [];
//
//   // ... loop through collections ...
//   // For "test_test_posts":
//   //   existingCollection will be undefined
//   //   app.save(new Collection(def)); // Creates 'test_test_posts'
//   //   newlyCreatedCollections.push("test_test_posts");
//   //   console.info(\`[PB] Created collection test_test_posts.\`);
//
// }, (app) => {
//   // addedFieldsToExistingCollections = [] for this migration
//   // newlyCreatedCollections = ["test_test_posts"] for this migration
//
//   // Rollback added fields from existing collections
//   console.info("[PB] Rolling back added fields...");
//   // addedFieldsToExistingCollections loop will run but the array should be empty.
//   for (const entry of addedFieldsToExistingCollections.reverse()) {
//     // ... this loop does nothing ...
//   }
//
//   // Rollback newly created collections
//   console.info("[PB] Rolling back newly created collections...");
//   for (const collectionName of newlyCreatedCollections.reverse()) { // Will iterate for 'test_test_posts'
//     try {
//       const col = app.findCollectionByNameOrId(collectionName); // 'test_test_posts'
//       if (col) {
//         app.deleteCollection(col); // Deletes 'test_test_posts' collection
//         console.info(\`[PB] Rolled back: deleted collection '\${collectionName}'.\`);
//       } // ...
//     } // ...
//   }
// });
  `);
  console.log("Note: Actual field IDs and collection IDs in the generated files will be random.");
  console.log("The 'randId' helper function is defined within each migration script.");
}

generateMigrationTest().catch(console.error);
