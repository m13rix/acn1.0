import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot32: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 5.98s total
	// Segments: 0-6s (Person), 6-12s (Scales) -> ~50/50 split
	const splitFrame = Math.round(durationInFrames / 2);

	// 1. Person Animation (0 - splitFrame)
	const zoom = interpolate(frame, [0, splitFrame], [1, 1.1], {
		extrapolateRight: 'clamp',
		easing: Easing.out(Easing.quad),
	});

	// 2. Scales Animation (splitFrame - end)
	// We'll simulate scales balancing by rotating the whole scene or an overlay
	const balanceProgress = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0, 1],
		{extrapolateLeft: 'clamp'}
	);

	const scaleRotation = Math.sin((frame - splitFrame) * 0.1) * 5 * (1 - balanceProgress); // Dampening oscillation

	// Text Overlay
	const textOpacity = interpolate(frame, [splitFrame, splitFrame + 15], [0, 1], {
		extrapolateLeft: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: '#f5f5f5'}}>
			{/* Main Image */}
			<AbsoluteFill
				style={{
					transform: `scale(${zoom}) rotate(${scaleRotation}deg)`,
					transformOrigin: '50% 30%', // Rotate around where scales might be
				}}
			>
				<Img
					src={staticFile('blindfold_division.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'contrast(1.1) saturate(0.9)',
					}}
				/>
			</AbsoluteFill>

			{/* Soft Justitia Glow */}
			<AbsoluteFill
				style={{
					background: 'radial-gradient(circle at 50% 40%, rgba(255, 255, 255, 0.2) 0%, transparent 60%)',
					pointerEvents: 'none',
				}}
			/>

			{/* Overlay Text */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-white/80 px-10 py-5 rounded-lg border-b-8 border-gold shadow-2xl backdrop-blur-sm"
					style={{
						opacity: textOpacity,
						borderColor: '#d4af37', // Gold
						transform: `translateY(${interpolate(textOpacity, [0, 1], [30, 0])}px)`
					}}
				>
					<h2 
						className="text-gray-900 text-4xl font-black uppercase tracking-widest text-center"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						Добросовестность = защита имущества
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot32_voice.mp3')} />
		</AbsoluteFill>
	);
};
