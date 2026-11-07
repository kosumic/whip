import { Modal, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from './ui/text';
import { ZoomableImagePreview } from './ZoomableImagePreview';

/** The shared full-screen viewer for prompt and assistant chat images. */
export function ChatImagePreview({ uri, onClose }: { uri: string; onClose: () => void }) {
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <SafeAreaView className="flex-1 bg-black">
        <Pressable accessibilityRole="button" accessibilityLabel="Close image" className="ml-auto min-h-12 items-center justify-center px-5" onPress={onClose}>
          <Text className="text-base text-white">Close</Text>
        </Pressable>
        <ZoomableImagePreview accessibilityLabel="Attached image" uri={uri} />
      </SafeAreaView>
    </Modal>
  );
}
