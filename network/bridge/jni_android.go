package main

/*
#include <jni.h>

static inline jsize requestLength(JNIEnv *env, jstring request) {
	return (*env)->GetStringLength(env, request);
}

static inline const jchar *requestChars(JNIEnv *env, jstring request) {
	return (*env)->GetStringChars(env, request, NULL);
}

static inline void releaseRequest(JNIEnv *env, jstring request, const jchar *chars) {
	(*env)->ReleaseStringChars(env, request, chars);
}

static inline jstring newReply(JNIEnv *env, const jchar *chars, jsize length) {
	return (*env)->NewString(env, chars, length);
}
*/
import "C"

import (
	"unicode/utf16"
	"unsafe"

	"twindesk.local/embedded/engine"
)

//export Java_com_twindesk_android_embedded_NativeNode_call
func Java_com_twindesk_android_embedded_NativeNode_call(env *C.JNIEnv, _ C.jclass, request C.jstring) C.jstring {
	if request == 0 {
		return javaString(env, invalidRequest)
	}
	input, ok := goString(env, request)
	if !ok {
		return 0 // The JVM has raised an allocation exception.
	}
	return javaString(env, engine.Call(input))
}

func goString(env *C.JNIEnv, input C.jstring) (string, bool) {
	length := C.requestLength(env, input)
	chars := C.requestChars(env, input)
	if chars == nil {
		return "", false
	}
	decoded := utf16.Decode(unsafe.Slice((*uint16)(unsafe.Pointer(chars)), int(length)))
	C.releaseRequest(env, input, chars)
	return string(decoded), true
}

func javaString(env *C.JNIEnv, text string) C.jstring {
	chars := utf16.Encode([]rune(text))
	return C.newReply(env, (*C.jchar)(unsafe.Pointer(unsafe.SliceData(chars))), C.jsize(len(chars)))
}
