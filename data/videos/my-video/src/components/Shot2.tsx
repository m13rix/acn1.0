import {
	AbsoluteFill,
	interpolate,
	spring,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
} from 'remotion';
import {Video} from '@remotion/media';
import React from 'react';

export const Shot2: React.FC = () => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();

	// Animations
	// Left side slides in (0s start)
	const leftEntrance = spring({
		frame,
		fps,
		config: {
			damping: 200,
		},
		durationInFrames: 30, // 1 second roughly
	});
	const leftX = interpolate(leftEntrance, [0, 1], [-50, 0]); // Slide from left off-screen

	// Right side slides in (starts slightly later, e.g., at 1s or just after left)
	// Instruction says "0-5s: Left side slides in, then right."
	const rightEntrance = spring({
		frame: frame - 20, // delayed by 20 frames
		fps,
		config: {
			damping: 200,
		},
		durationInFrames: 30,
	});
	const rightX = interpolate(rightEntrance, [0, 1], [50, 0]); // Slide from right off-screen (relative to its container)

	// VS Icon animation (starts at 5s)
	// Pulsing animation
	const vsStartFrame = 5 * fps;
	const vsOpacity = interpolate(frame, [vsStartFrame, vsStartFrame + 10], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	const pulse = Math.sin((frame - vsStartFrame) / 10) * 0.1 + 1; // Base scale 1, oscillates +/- 0.1
	const vsScale = frame < vsStartFrame ? 0 : pulse;

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{/* Left Split (50% width) */}
			<AbsoluteFill
				style={{
					width: '50%',
					left: 0,
					overflow: 'hidden',
					transform: `translateX(${leftX}%)`,
				}}
			>
				<Img
					src={staticFile('wedding_vintage.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'sepia(0.6)', // Slight sepia tone
					}}
				/>
				{/* Sepia overlay for stronger tint if needed */}
				<div
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						width: '100%',
						height: '100%',
						backgroundColor: 'rgba(112, 66, 20, 0.2)', // Brownish tint
						mixBlendMode: 'overlay',
					}}
				/>
			</AbsoluteFill>

			{/* Right Split (50% width) */}
			<AbsoluteFill
				style={{
					width: '50%',
					left: '50%',
					overflow: 'hidden',
					transform: `translateX(${rightX}%)`,
				}}
			>
				<Img
					src={staticFile('divorce_documents.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						// Cold blue tone: desaturate slightly to let overlay color take over
						filter: 'grayscale(0.3) contrast(1.1)', 
					}}
				/>
				{/* Cold blue overlay */}
				<div
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						width: '100%',
						height: '100%',
						backgroundColor: 'rgba(0, 50, 200, 0.4)', // Stronger blue
						mixBlendMode: 'hard-light',
					}}
				/>
			</AbsoluteFill>

			{/* VS Icon */}
			<AbsoluteFill
				style={{
					justifyContent: 'center',
					alignItems: 'center',
					opacity: vsOpacity,
					transform: `scale(${vsScale})`,
				}}
			>
				<div
					className="bg-red-600 text-white font-bold rounded-full flex items-center justify-center border-4 border-white shadow-xl"
					style={{
						width: 150,
						height: 150,
						fontSize: 80,
						fontFamily: 'Inter, sans-serif',
						zIndex: 10,
					}}
				>
					VS
				</div>
			</AbsoluteFill>

			{/* Film Grain Overlay */}
			<AbsoluteFill style={{opacity: 0.2, pointerEvents: 'none'}}>
				<Video
					src={staticFile('film_grain.mp4')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
					muted
					loop
				/>
			</AbsoluteFill>

			<Audio src={staticFile('shot2_voice.mp3')} />
		</AbsoluteFill>
	);
};
