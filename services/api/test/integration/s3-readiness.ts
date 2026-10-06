/**
 * Comprobación de disponibilidad S3 **neutra respecto al proveedor y autenticada**.
 *
 * Antes se sondeaba `GET ${S3_ENDPOINT}/minio/health/live`: una ruta HTTP específica de MinIO
 * que el sustituto del CI (SeaweedFS) no sirve, de modo que la sonda daba falso y el drill
 * podía quedar omitido. Aquí se ejecuta una operación real del API S3 (ListBuckets), que
 * prueba de verdad que el endpoint responde y que las credenciales valen, sin depender de
 * rutas propias de ningún proveedor.
 */
export async function s3Disponible(endpoint: string, accessKeyId: string, secretAccessKey: string): Promise<boolean> {
  try {
    const { S3Client, ListBucketsCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: "us-east-1",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    await client.send(new ListBucketsCommand({}));
    return true;
  } catch {
    return false;
  }
}
