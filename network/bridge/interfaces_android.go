package main

// #include <jni.h>
import "C"

import "twindesk.local/embedded/mobileif"

//export Java_com_twindesk_android_embedded_NativeInterfaces_publish
func Java_com_twindesk_android_embedded_NativeInterfaces_publish(env *C.JNIEnv, _ C.jclass, snapshot C.jstring) C.jboolean {
	if snapshot == 0 {
		return C.JNI_FALSE
	}
	input, ok := goString(env, snapshot)
	if !ok || !mobileif.Publish(input) {
		return C.JNI_FALSE
	}
	return C.JNI_TRUE
}
