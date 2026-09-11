async function firestoreOperation(page, operation, documentPath, data = null) {
  return page.evaluate(async ({ operation, documentPath, data }) => {
    const { db, auth, LOCAL_E2E_RUNTIME } = await import("/js/firebase-init.js");
    const sdk = await import("https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js");
    if (LOCAL_E2E_RUNTIME?.projectId !== "demo-edenatlas-e2e") throw new Error("non-demo-runtime");
    const reference = sdk.doc(db, documentPath);
    try {
      if (operation === "get") {
        const snapshot = await sdk.getDoc(reference);
        return { ok: true, exists: snapshot.exists(), data: snapshot.exists() ? snapshot.data() : null, uid: auth.currentUser?.uid || null };
      }
      if (operation === "set") await sdk.setDoc(reference, data);
      else if (operation === "update") await sdk.updateDoc(reference, data);
      else if (operation === "delete") await sdk.deleteDoc(reference);
      else throw new Error("unknown-firestore-operation");
      return { ok: true, uid: auth.currentUser?.uid || null };
    } catch (error) {
      return { ok: false, code: error?.code || "unknown", uid: auth.currentUser?.uid || null };
    }
  }, { operation, documentPath, data });
}

async function storageOperation(page, operation, objectPath, content = "e2e fixture") {
  return page.evaluate(async ({ operation, objectPath, content }) => {
    const { storage, auth, LOCAL_E2E_RUNTIME } = await import("/js/firebase-init.js");
    const sdk = await import("https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js");
    if (LOCAL_E2E_RUNTIME?.projectId !== "demo-edenatlas-e2e") throw new Error("non-demo-runtime");
    const reference = sdk.ref(storage, objectPath);
    try {
      if (operation === "get") {
        const blob = await sdk.getBlob(reference);
        return { ok: true, text: await blob.text(), uid: auth.currentUser?.uid || null };
      }
      if (operation === "upload") {
        await sdk.uploadBytes(reference, new Blob([content], { type: "text/plain" }), { contentType: "text/plain" });
      } else if (operation === "delete") {
        await sdk.deleteObject(reference);
      } else {
        throw new Error("unknown-storage-operation");
      }
      return { ok: true, uid: auth.currentUser?.uid || null };
    } catch (error) {
      return { ok: false, code: error?.code || "unknown", uid: auth.currentUser?.uid || null };
    }
  }, { operation, objectPath, content });
}

module.exports = { firestoreOperation, storageOperation };
