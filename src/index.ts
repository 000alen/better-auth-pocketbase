import PocketBase from "pocketbase";
import { CleanedWhere, createAdapter, CustomAdapter, type AdapterDebugLogs } from "better-auth/adapters";
import { getRandomId, offsetToPage, sortByToFilter, whereToFilter } from "./utils.js";
import { AdapterSchemaCreation } from "better-auth/types";
import { generatePocketBaseSchema } from "./codegen.js";

/**
 * Runtime configuration that the integrator may supply when instantiating the adapter.
 */
export interface PocketBaseAdapterConfig {
  pb?: PocketBase;

  /** Base URL of the PocketBase instance (eg. http://127.0.0.1:8090) */
  url?: string;
  /** Optional admin or record auth token to perform privileged operations */

  // authToken?: string;
  authToken?: string | { email: string, password: string };

  /** Optional string prefix applied to all Better‑Auth model names when mapping to PB collections */
  collectionPrefix?: string;

  /** Fine‑grained debug logging */
  debugLogs?: AdapterDebugLogs | boolean;

  generateMigration?: boolean;
  migrationFile?: string;

  batchApi?: {
    enabled: boolean;
    batchSize?: number;
  }
}

export const pocketbaseAdapter = (adapterConfig: PocketBaseAdapterConfig): ReturnType<typeof createAdapter> =>
  createAdapter({
    config: {
      adapterId: "pocketbase",
      adapterName: "PocketBase Adapter",
      debugLogs: adapterConfig.debugLogs ?? false,
      supportsJSON: true, // PocketBase JSON field type
      supportsDates: true,
      supportsBooleans: true,
      supportsNumericIds: false, // PB uses 15‑char Alphanumeric IDs by default

      customIdGenerator() {
        // * NOTE(@000alen): not sure if this needs to be cryptographically secure
        return getRandomId();
      },
    },

    adapter: ({
      options: _options,
      debugLog,
      schema,
      // getDefaultModelName: _getDefaultModelName,
      // getDefaultFieldName: _getDefaultFieldName,
    }): CustomAdapter => {
      let ready: Promise<any> | null = null;

      let pb: PocketBase;

      if (adapterConfig.pb) {
        pb = adapterConfig.pb;
      } else if (adapterConfig.url) {
        pb = new PocketBase(adapterConfig.url);
      } else {
        throw new Error("PocketBase instance or URL is required");
      }

      if (adapterConfig.authToken) {
        if (typeof adapterConfig.authToken === "string") {
          // * NOTE(@000alen): token, model (unused)
          pb.authStore.save(adapterConfig.authToken, null);
        } else {
          ready = pb.admins.authWithPassword(adapterConfig.authToken.email, adapterConfig.authToken.password);
        }
      }

      const collection = <T>(model: string) => pb.collection<T>(
        adapterConfig.collectionPrefix
          ? `${adapterConfig.collectionPrefix}${model}`
          : model
      );

      const findOne: CustomAdapter['findOne'] = async <T>({ model, where }: {
        model: string;
        where: CleanedWhere[];

        // * NOTE(@000alen): select can be ignored
        select?: string[];
      }): Promise<T> => {
        if (ready) await ready;

        const filter = whereToFilter(where);

        const record = await collection<T>(model)
          .getFirstListItem(filter)
          .catch((error) => {
            debugLog(`Error finding record in ${model}: ${error}`);
            // * NOTE(@000alen): this is undocumented, function signature suggests it should throw, as the return type is T and not T | null
            // throw error;
            return null;
          });

        return record as T;
      }

      const findMany: CustomAdapter["findMany"] = async <T>({ model, where, limit, sortBy, offset }: {
        model: string;
        where?: CleanedWhere[];
        limit: number;
        sortBy?: { field: string; direction: "asc" | "desc"; };
        offset?: number;
      }): Promise<T[]> => {
        if (ready) await ready;

        const page = offsetToPage(offset, limit);
        const filter = whereToFilter(where);
        const sort = sortByToFilter(sortBy);

        const records = await collection<T>(model)
          .getList(
            page,
            limit ?? 30,
            {
              filter,
              sort,
            })
          .catch((error) => {
            debugLog(`Error finding records in ${model}: ${error}`);
            throw error;
          });

        return records.items;
      }

      const create: CustomAdapter['create'] = async <T extends Record<string, any>>({ model, data }: {
        model: string;
        data: T;

        // * NOTE(@000alen): select can be ignored
        select?: string[];
      }) => {
        if (ready) await ready;

        const record = await collection<T>(model)
          .create(data)
          .catch((error) => {
            debugLog(`Error creating record in ${model}: ${error}`);

            throw error;
          });

        debugLog(`Created record in ${model}`);

        return record;
      }

      const update: CustomAdapter['update'] = async <T>({ model, where, update }: {
        model: string;
        where: CleanedWhere[];
        update: T;
      }): Promise<T | null> => {
        if (ready) await ready;

        const filter = whereToFilter(where);

        const { id } = await collection<{ id: string }>(model)
          .getFirstListItem(filter, { fields: "id" })
          .then((result) => {
            if (!result) {
              throw new Error("Record not found");
            }

            return result;
          })
          .catch((error) => {
            debugLog(`Error finding record in ${model}: ${error}`);
            throw error;
          })

        const record = await collection<T>(model)
          .update(
            id,
            update as Record<string, any>
          )
          .catch((error) => {
            debugLog(`Error updating record in ${model}: ${error}`);
            throw error;
          });

        debugLog(`Updated record ${id} in ${model}`);

        return record;
      };

      // * NOTE(@000alen): this should update all records that match the where clause
      const updateMany: CustomAdapter['updateMany'] = async ({ model, where, update }: {
        model: string;
        where: CleanedWhere[];
        update: Record<string, any>;
      }): Promise<number> => {
        if (ready) await ready;

        const filter = whereToFilter(where);

        const records = await collection<{ id: string }>(model)
          .getFullList({
            filter,
            fields: "id"
          })
          .catch((error) => {
            debugLog(`Error finding records in ${model}: ${error}`);
            throw error;
          });

        // * NOTE(@000alen): add support for batch api
        if (adapterConfig.batchApi?.enabled) {
          const batchSize = adapterConfig.batchApi.batchSize ?? 100;

          const batches = [];
          for (let i = 0; i < records.length; i += batchSize) {
            const batch = pb.createBatch();
            const batchRecords = records.slice(i, i + batchSize);

            batchRecords.forEach((r) => {
              batch.collection(model).update(
                r.id,
                update as Record<string, any>
              );
            });

            batches.push(batch);
          }

          const batchResults = await Promise.all(batches.map(batch => batch.send()));
          const results = batchResults.flat();

          const count = results.filter((r) => 200 <= r.status && r.status < 300).length;

          debugLog(`Updated ${count} records in ${model}`);

          return count;
        } else {
          const results = await Promise.allSettled(
            records.map((r) => collection(model).update(
              r.id,
              update as Record<string, any>
            ))
          )

          const count = results.filter((r) => r.status === "fulfilled").length;

          debugLog(`Updated ${count} records in ${model}`);

          return count;
        }
      }

      const _delete: CustomAdapter['delete'] = async ({ model, where }: {
        model: string;
        where: CleanedWhere[];
      }): Promise<void> => {
        if (ready) await ready;

        const filter = whereToFilter(where);

        const { id } = await collection<{ id: string }>(model)
          .getFirstListItem(filter, { fields: "id" })
          .then((result) => {
            if (!result) {
              throw new Error("Record not found");
            }

            return result;
          })
          .catch((error) => {
            debugLog(`Error finding record in ${model}: ${error}`);
            throw error;
          })

        await collection(model)
          .delete(id)
          .catch((error) => {
            debugLog(`Error deleting record in ${model}: ${error}`);
            throw error;
          })

        debugLog(`Deleted record ${id} in ${model}`);
      }

      const deleteMany: CustomAdapter['deleteMany'] = async ({ model, where }: {
        model: string;
        where: CleanedWhere[];
      }): Promise<number> => {
        if (ready) await ready;

        const filter = whereToFilter(where);

        const records = await collection<{ id: string }>(model)
          .getFullList({
            filter,
            fields: "id"
          })
          .catch((error) => {
            debugLog(`Error finding records in ${model}: ${error}`);
            throw error;
          });

        if (adapterConfig.batchApi?.enabled) {
          const batchSize = adapterConfig.batchApi.batchSize ?? 100;

          const batches = [];
          for (let i = 0; i < records.length; i += batchSize) {
            const batch = pb.createBatch();
            const batchRecords = records.slice(i, i + batchSize);

            batchRecords.forEach((r) => {
              batch.collection(model).delete(r.id);
            });

            batches.push(batch);
          }

          const batchResults = await Promise.all(batches.map(batch => batch.send()));
          const results = batchResults.flat();

          const count = results.filter((r) => 200 <= r.status && r.status < 300).length;

          debugLog(`Deleted ${count} records in ${model}`);

          return count;
        } else {
          const results = await Promise.allSettled(
            records.map((r) => collection(model).delete(r.id))
          )

          const count = results.filter((r) => r.status === "fulfilled").length;

          debugLog(`Deleted ${count} records in ${model}`);

          return count;
        }
      }

      const count: CustomAdapter['count'] = async ({ model, where }: {
        model: string;
        where?: CleanedWhere[];
      }): Promise<number> => {
        if (ready) await ready;

        const filter = whereToFilter(where);

        const count = await collection(model)
          .getFullList({
            filter,
            fields: "id"
          })
          .then((list) => list.length);

        return count;
      }

      const createSchema: CustomAdapter["createSchema"] = async ({
        file,
        tables,
      }): Promise<AdapterSchemaCreation> => {
        if (ready) await ready;

        return generatePocketBaseSchema({
          tables,
          file,
          collectionPrefix: adapterConfig.collectionPrefix,
        });
      };

      if (adapterConfig.generateMigration) {
        createSchema({
          file: adapterConfig.migrationFile,
          tables: schema,
        })
          .then(async (result) => {
            const fs = await import("fs");
            fs.writeFileSync(result.path, result.code);
          })
      }

      return {
        /* Expose adapter‑level options for downstream consumers */
        options: adapterConfig,

        create,
        update,
        updateMany,
        findOne,
        findMany,
        delete: _delete,
        deleteMany,
        count,
        createSchema,

        async getCollectionSchemaByName(collectionName: string): Promise<any | null> {
          if (ready) await ready;
          const fullCollectionName = adapterConfig.collectionPrefix
            ? `${adapterConfig.collectionPrefix}${collectionName}`
            : collectionName;
          try {
            const collectionData = await pb.collections.getOne(fullCollectionName);
            return collectionData.schema;
          } catch (error: any) {
            if (error.status === 404) {
              debugLog(`Collection ${fullCollectionName} not found.`);
              return null;
            }
            debugLog(`Error fetching collection ${fullCollectionName}: ${error}`);
            throw error;
          }
        },

      } satisfies CustomAdapter;
    },
  });
