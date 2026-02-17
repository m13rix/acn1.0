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

export const Shot19: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 7.63s total
	// Segments: 0-6s (Appear), 6-12s (Intensify) -> 50/50 split approx
	const splitFrame = Math.round((6 / 12) * durationInFrames);

	// Silhouette Appearance (Fade in + Scale up)
	const silhouetteOpacity = interpolate(
		frame,
		[0, splitFrame],
		[0, 1],
		{extrapolateRight: 'clamp'}
	);
	
	const silhouetteScale = interpolate(
		frame,
		[0, durationInFrames],
		[0.9, 1],
		{easing: Easing.out(Easing.quad)}
	);

	// Protective Circle Barrier
	// Rotating and pulsing circle
	const rotation = interpolate(frame, [0, durationInFrames], [0, 360]);
	
	// Force field intensification (after splitFrame)
	const forceFieldIntensity = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0, 1],
		{extrapolateLeft: 'clamp'}
	);

	const barrierOpacity = interpolate(
		frame,
		[0, splitFrame],
		[0, 0.5],
		{extrapolateRight: 'clamp'}
	);

	const pulse = Math.sin(frame * 0.2) * 0.05 + 1; // Base pulse

	// Text Overlay
	const textOpacity = interpolate(
		frame,
		[splitFrame, splitFrame + 20],
		[0, 1],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	return (
		<AbsoluteFill style={{backgroundColor: '#050510'}}>
			{/* Pregnant Silhouette */}
			<AbsoluteFill
				style={{
					opacity: silhouetteOpacity,
					transform: `scale(${silhouetteScale})`,
				}}
			>
				<Img
					src={staticFile('pregnant_protection.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'contain',
						filter: 'drop-shadow(0 0 10px rgba(100, 200, 255, 0.3))',
					}}
				/>
			</AbsoluteFill>

			{/* Protective Barrier (Force Field) */}
			<AbsoluteFill className="justify-center items-center">
				<div
					style={{
						width: 600,
						height: 600,
						borderRadius: '50%',
						border: `4px dashed rgba(100, 200, 255, ${barrierOpacity + forceFieldIntensity * 0.5})`,
						transform: `rotate(${rotation}deg) scale(${pulse + forceFieldIntensity * 0.1})`,
						boxShadow: `0 0 ${20 + forceFieldIntensity * 50}px rgba(100, 200, 255, ${0.2 + forceFieldIntensity * 0.4})`,
					}}
				/>
				{/* Inner Glow Field */}
				<div
					style={{
						position: 'absolute',
						width: 550,
						height: 550,
						borderRadius: '50%',
						background: 'radial-gradient(circle, rgba(100, 200, 255, 0.1) 0%, transparent 70%)',
						opacity: barrierOpacity + forceFieldIntensity * 0.5,
						mixBlendMode: 'screen',
					}}
				/>
			</AbsoluteFill>

			{/* Text Overlay with Clock Icon */}
			<AbsoluteFill 
				className="justify-end items-center pb-20"
				style={{opacity: textOpacity}}
			>
				<div className="flex flex-row items-center space-x-4 bg-black/60 px-6 py-3 rounded-xl border border-blue-500/50 backdrop-blur-md">
					{/* CSS Clock Icon */}
					<div className="relative w-12 h-12 rounded-full border-2 border-white flex justify-center items-center">
						<div className="absolute w-0.5 h-4 bg-white top-2 origin-bottom transform rotate-45" />
						<div className="absolute w-0.5 h-3 bg-white top-3 origin-bottom transform -rotate-90" />
					</div>
					
					<h2 
						className="text-white text-3xl font-bold uppercase tracking-wide"
						style={{
							fontFamily: 'Inter, sans-serif',
							textShadow: '0 0 10px rgba(100, 200, 255, 0.8)',
						}}
					>
						триста шестьдесят пять дней защиты
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot19_voice.mp3')} />
		</AbsoluteFill>
	);
};
